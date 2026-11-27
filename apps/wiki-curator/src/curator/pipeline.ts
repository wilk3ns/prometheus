import {
  LinkHealerResult,
  VerificationReport,
  wikiNodeProposalSchema,
  type Citation,
  type ModelFamily,
  type SlotCompleteness,
  type WikiLayer,
  type WikiNodeProposal,
} from '@prometheus/contracts';
import type { GenerateCall, ModelResult, ModelRouter, UntrustedDocument } from '@prometheus/ai';
import type { ClockPort } from '@prometheus/kernel';
import type {
  SnapshotReaderPort,
  StoredNode,
  StoredSnapshot,
  WikiLayerRepository,
} from '../persistence/wiki-layer-repository.js';
import { acceptHealerChoice, planSources } from './healer.js';
import { LAYERS, parseFields, safeParseFields } from './layers.js';
import type { MaterializeResult, Materializer } from './materializer.js';
import { getPath, hasPath, withPath } from './paths.js';
import { decidePublish, type GateDecision } from './publish-gate.js';
import {
  validateProposal,
  type LockConflict,
  type SourceSnapshotView,
  type ValidationError,
} from './validators.js';

/**
 * Dual-pass curator pipeline (ENG-T2 §4). Each public method is ONE durable step of WF-03 / WF-19 (see
 * workflows.ts): inputs and outputs are plain JSON so the workflow engine can checkpoint them. Models are
 * reached only through the ModelRouter and only ever PROPOSE; validators + the publish gate decide, and
 * the commit is a single wiki_writer transaction.
 */

/** Upper bound on source text sent to a model per call (keeps deep_extract inside its $0.50 cap). */
export const MAX_SOURCE_CHARS = 200_000;

export interface NodeTarget {
  readonly layer: WikiLayer;
  readonly nodeKey: string;
  readonly season: string;
  readonly targetKey: string;
}

export interface SourceDocument {
  readonly snapshotId: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly kind: 'web' | 'pdf';
  readonly text: string;
  readonly retrievedAt: string;
}

export interface Gathered {
  readonly documents: readonly SourceDocument[];
  readonly slots: SlotCompleteness;
  readonly healed: ReadonlyArray<{ readonly missingUrl: string; readonly replacementUrl: string }>;
}

export interface ExistingView {
  readonly version: number;
  readonly depth: StoredNode['depth'];
  readonly lockedPaths: readonly string[];
  readonly fields: Record<string, unknown>;
}

export interface Validated {
  readonly errors: readonly ValidationError[];
  readonly lockConflicts: readonly LockConflict[];
  /** Effective fields (locks + ops-owned columns applied); `null` when they do not form a valid node. */
  readonly fields: Record<string, unknown> | null;
}

export type CommitStatus =
  'DEEP_VERIFIED' | 'BASELINE' | 'QUARANTINED' | 'KEPT_DEEP_VERIFIED' | 'NEEDS_OPS_INPUT';

export interface CommitOutcome {
  readonly status: CommitStatus;
  readonly version: number | null;
  readonly materialized: MaterializeResult;
}

export interface CuratorDeps {
  readonly router: ModelRouter;
  readonly layers: WikiLayerRepository;
  readonly snapshots: SnapshotReaderPort;
  readonly isAllowlisted: (url: URL) => boolean;
  readonly materializer: Materializer;
  readonly clock: ClockPort;
  /** Optional model tie-break for ambiguous 404 siblings (RTE-wiki.link_healer). */
  readonly useModelLinkHealer: boolean;
}

export type ExtractRoute = 'RTE-wiki.deep_extract' | 'RTE-wiki.baseline_extract';

function proposalSchema(layer: WikiLayer) {
  return wikiNodeProposalSchema(layer, LAYERS[layer].proposal);
}

/** Template vars + documents of an Agent A call (pure: shared with cassette synthesis). */
export function buildExtractCall(
  route: ExtractRoute,
  target: NodeTarget,
  gathered: Gathered,
  feedback: string | null,
  ids: { readonly idempotencyKey: string; readonly callKey: string },
): GenerateCall<WikiNodeProposal> {
  return {
    route,
    dataClass: 'OFFICIAL_SOURCE_ONLY',
    idempotencyKey: ids.idempotencyKey,
    callKey: ids.callKey,
    vars: {
      layer: target.layer,
      node_key: target.nodeKey,
      season: target.season,
      sources: gathered.documents.map((d) => ({
        snapshot_id: d.snapshotId,
        url: d.finalUrl,
        kind: d.kind,
        retrieved_at: d.retrievedAt,
      })),
      feedback: feedback === null ? '' : `Previous attempt was rejected: ${feedback}`,
    },
    untrusted: gathered.documents.map((d): UntrustedDocument => ({
      kind: d.kind,
      url: d.finalUrl,
      text: d.text,
    })),
    schema: proposalSchema(target.layer),
    schemaName: `wiki_node_proposal_${target.layer.toLowerCase()}`,
  };
}

/** Agent B call; `excludeFamily` is Agent A's served family (GR-AI-009). */
export function buildVerifyCall(
  target: NodeTarget,
  gathered: Gathered,
  proposal: WikiNodeProposal,
  effectiveFields: Record<string, unknown>,
  excludeFamily: ModelFamily,
  ids: { readonly idempotencyKey: string; readonly callKey: string },
): GenerateCall<VerificationReport> {
  return {
    route: 'RTE-wiki.deep_verify',
    dataClass: 'OFFICIAL_SOURCE_ONLY',
    idempotencyKey: ids.idempotencyKey,
    callKey: ids.callKey,
    excludeFamily,
    vars: {
      layer: target.layer,
      node_key: target.nodeKey,
      season: target.season,
      required_paths: LAYERS[target.layer].requiredPaths,
      proposal: {
        fields: effectiveFields,
        citations: proposal.citations,
        abstain_fields: proposal.abstain_fields,
      },
    },
    untrusted: gathered.documents.map((d): UntrustedDocument => ({
      kind: d.kind,
      url: d.finalUrl,
      text: d.text,
    })),
    schema: VerificationReport,
    schemaName: 'verification_report',
  };
}

function summarize(errors: readonly ValidationError[]): string {
  return errors
    .map((e) => `${e.code} at ${e.path}: ${e.detail}`)
    .join('; ')
    .slice(0, 2_000);
}

export function retryFeedback(
  validated: Validated,
  gate: GateDecision | undefined,
  report: VerificationReport | undefined,
): string {
  const parts: string[] = [];
  if (validated.errors.length > 0) parts.push(`validator errors: ${summarize(validated.errors)}`);
  if (report && report.discrepancies.length > 0) {
    parts.push(
      `verifier discrepancies: ${report.discrepancies.map((d) => `${d.field_path} ${d.kind}: ${d.detail}`).join('; ')}`,
    );
  }
  if (gate && gate.uncheckedPaths.length > 0)
    parts.push(`unverified required paths: ${gate.uncheckedPaths.join(', ')}`);
  if (gate && gate.abstainedRequired.length > 0)
    parts.push(`abstained required paths: ${gate.abstainedRequired.join(', ')}`);
  return parts.join(' | ').slice(0, 4_000);
}

/** Deterministic post-validation of one proposal against the gathered sources (pure; ENG-T2 §4 step 3). */
export function validateNodeProposal(
  target: NodeTarget,
  proposal: WikiNodeProposal,
  gathered: Gathered,
  existing: ExistingView | null,
  isAllowlisted: (url: URL) => boolean,
  now: Date,
): Validated {
  const descriptor = LAYERS[target.layer];
  const snapshots = new Map<string, SourceSnapshotView>(
    gathered.documents.map((d) => [
      d.snapshotId,
      { id: d.snapshotId, requestedUrl: d.requestedUrl, finalUrl: d.finalUrl, cleanText: d.text },
    ]),
  );
  // ops-owned columns (e.g. pricing tier) always come from the stored row, never from a model
  let proposed: Record<string, unknown> = { ...proposal.fields };
  for (const path of descriptor.opsOwnedPaths) {
    if (existing && hasPath(existing.fields, path))
      proposed = withPath(proposed, path, getPath(existing.fields, path));
  }
  const outcome = validateProposal({
    expectedNodeKey: target.nodeKey,
    nodeKeyOf: (f) => descriptor.nodeKeyOf(f) ?? '<invalid identifying fields>',
    proposal: { node_key: proposal.node_key, fields: proposed, citations: proposal.citations },
    snapshots,
    isAllowlisted,
    lockedPaths: existing?.lockedPaths ?? [],
    existingFields: existing?.fields,
    now,
  });
  const full = descriptor.fields.safeParse(outcome.effectiveFields);
  return {
    errors: outcome.errors,
    lockConflicts: outcome.lockConflicts,
    fields: full.success ? { ...full.data } : null,
  };
}

/** Publish gate over one round (pure; GR-AI-010). */
export function gateDecision(
  target: NodeTarget,
  validated: Validated,
  proposal: WikiNodeProposal,
  report: VerificationReport | undefined,
): GateDecision {
  return decidePublish({
    validatorErrors: validated.errors,
    report,
    requiredPaths: LAYERS[target.layer].requiredPaths,
    abstainFields: proposal.abstain_fields,
  });
}

export class DualPassCurator {
  constructor(private readonly deps: CuratorDeps) {}

  /** Step: current stored state of the node (locks, version, depth) or `null` for a new node. */
  async loadExisting(layer: WikiLayer, nodeKey: string): Promise<ExistingView | null> {
    const node = await this.deps.layers.findNode(layer, nodeKey);
    if (node === undefined) return null;
    return {
      version: node.version,
      depth: node.depth,
      lockedPaths: node.lockedPaths,
      fields: { ...node.fields },
    };
  }

  /** Step 1: gather the target's stored snapshots, heal 404s, read clean texts (bounded). */
  async gather(targetKey: string, runId: string): Promise<Gathered> {
    const listed = await this.deps.snapshots.listTargetSnapshots(targetKey);
    if (listed === undefined) throw new Error(`unknown crawl target ${targetKey}`);
    let plan = planSources(listed.seedUrls, listed.rows);
    if (this.deps.useModelLinkHealer) plan = await this.healWithModel(plan, listed.rows, runId);
    const documents: SourceDocument[] = [];
    let budget = MAX_SOURCE_CHARS;
    for (const s of plan.snapshots) {
      if (s.cleanTextBlobRef === null) continue;
      const text = await this.deps.snapshots.readCleanText(s.cleanTextBlobRef);
      if (text.length > budget) continue;
      budget -= text.length;
      documents.push({
        snapshotId: s.id,
        requestedUrl: s.requestedUrl,
        finalUrl: s.finalUrl,
        kind: s.contentKind === 'PDF' ? 'pdf' : 'web',
        text,
        retrievedAt: s.fetchedAt,
      });
    }
    return { documents, slots: plan.slots, healed: plan.healed };
  }

  private async healWithModel(
    plan: ReturnType<typeof planSources>,
    rows: readonly StoredSnapshot[],
    runId: string,
  ): Promise<ReturnType<typeof planSources>> {
    let current = plan;
    for (const [i, amb] of plan.ambiguous.entries()) {
      const result = await this.deps.router.generate({
        route: 'RTE-wiki.link_healer',
        dataClass: 'OFFICIAL_SOURCE_ONLY',
        idempotencyKey: `${runId}:heal:${i}`,
        vars: {
          missing_url: amb.missingUrl,
          expected: 'the same official information as the missing page',
          candidates: amb.candidates.map((c) => ({ url: c.url, anchor_text: c.anchorText })),
        },
        schema: LinkHealerResult,
        schemaName: 'link_healer_result',
      });
      // the model may only pick among the offered candidates; anything else is ignored
      if (result.ok) current = acceptHealerChoice(current, amb.missingUrl, result.value.chosen_url, rows);
    }
    return current;
  }

  /** Step 2: Agent A extraction (deep or baseline route). */
  extract(
    route: ExtractRoute,
    target: NodeTarget,
    gathered: Gathered,
    feedback: string | null,
    ids: { idempotencyKey: string; callKey: string },
  ): Promise<ModelResult<WikiNodeProposal>> {
    return this.deps.router.generate(buildExtractCall(route, target, gathered, feedback, ids));
  }

  /** Step 3: deterministic post-validation (pure; no model). */
  validate(
    target: NodeTarget,
    proposal: WikiNodeProposal,
    gathered: Gathered,
    existing: ExistingView | null,
  ): Validated {
    return validateNodeProposal(
      target,
      proposal,
      gathered,
      existing,
      this.deps.isAllowlisted,
      this.deps.clock.now(),
    );
  }

  /** Step 4: Agent B cross-family verification. */
  verify(
    target: NodeTarget,
    gathered: Gathered,
    proposal: WikiNodeProposal,
    effectiveFields: Record<string, unknown>,
    excludeFamily: ModelFamily,
    ids: { idempotencyKey: string; callKey: string },
  ): Promise<ModelResult<VerificationReport>> {
    return this.deps.router.generate(
      buildVerifyCall(target, gathered, proposal, effectiveFields, excludeFamily, ids),
    );
  }

  /** Step 5a: publish gate (pure). */
  gate(
    target: NodeTarget,
    validated: Validated,
    proposal: WikiNodeProposal,
    report: VerificationReport | undefined,
  ): GateDecision {
    return gateDecision(target, validated, proposal, report);
  }

  /**
   * Step 5b: commit in ONE wiki_writer transaction (node row + node_revision + Slice Cards + search text).
   * `publish` = DEEP_VERIFIED (WF-03 PASS) or BASELINE (WF-19); otherwise the node is QUARANTINED.
   */
  async commit(args: {
    readonly target: NodeTarget;
    readonly mode: 'DEEP_VERIFIED' | 'BASELINE' | 'QUARANTINE';
    readonly expectedVersion: number;
    readonly proposal: WikiNodeProposal | null;
    readonly validated: Validated | null;
    readonly report: VerificationReport | null;
    readonly gathered: Gathered;
    readonly reason: string;
  }): Promise<CommitOutcome> {
    const { target } = args;
    const empty: MaterializeResult = { cards: [], evict: [], searchTexts: [] };
    return this.deps.layers.transaction(async (store) => {
      const existing = await store.findNode(target.layer, target.nodeKey);
      if (args.mode === 'BASELINE' && existing?.depth === 'DEEP_VERIFIED') {
        // a seasonal baseline never downgrades a deep-verified node
        return { status: 'KEPT_DEEP_VERIFIED', version: existing.version, materialized: empty };
      }
      const fields = args.validated?.fields ?? null;
      const citations: Citation[] = (args.proposal?.citations ?? []).map((c) => ({ ...c }));
      const slots: SlotCompleteness = { ...(args.proposal?.slot_completeness ?? {}), ...args.gathered.slots };
      const isSpec = target.layer === 'PROGRAM_SPEC';
      const evidence = {
        proposal: args.proposal,
        validator_errors: args.validated?.errors ?? [],
        lock_conflicts: args.validated?.lockConflicts ?? [],
        report: args.report,
        healed: args.gathered.healed,
      };

      if (args.mode !== 'QUARANTINE' && fields !== null) {
        const version = await store.writeNode({
          layer: target.layer,
          nodeKey: target.nodeKey,
          fields: parseFields(target.layer, fields),
          depth: args.mode,
          score: args.mode === 'DEEP_VERIFIED' ? (args.report?.verification_score ?? null) : null,
          citations,
          slotCompleteness: slots,
          wikiStatus: isSpec ? 'ACTIVE' : null,
          lockedPaths: existing?.lockedPaths ?? [],
          expectedVersion: args.expectedVersion,
          actor: 'AI_CURATOR',
          reason: args.reason,
          verifiedAt: this.deps.clock.now(),
        });
        const materialized = await this.deps.materializer.materialize(
          store,
          target.layer,
          target.nodeKey,
          target.season,
        );
        return { status: args.mode, version: version.version, materialized };
      }

      // FAIL path: never expose the node to ACTIVE matching
      if (existing !== undefined) {
        const version = await store.quarantineNode({
          layer: target.layer,
          nodeKey: target.nodeKey,
          expectedVersion: args.expectedVersion,
          actor: 'AI_CURATOR',
          reason: args.reason,
          evidence,
        });
        const materialized = await this.deps.materializer.materialize(
          store,
          target.layer,
          target.nodeKey,
          target.season,
        );
        return { status: 'QUARANTINED', version, materialized };
      }
      const parsed = fields === null ? undefined : safeParseFields(target.layer, fields);
      if (parsed !== undefined) {
        const version = await store.writeNode({
          layer: target.layer,
          nodeKey: target.nodeKey,
          fields: parsed,
          depth: 'QUARANTINED',
          score: args.report?.verification_score ?? null,
          citations,
          slotCompleteness: slots,
          wikiStatus: isSpec ? 'DRAFT' : null,
          lockedPaths: [],
          expectedVersion: 0,
          actor: 'AI_CURATOR',
          reason: args.reason,
          verifiedAt: this.deps.clock.now(),
        });
        return { status: 'QUARANTINED', version: version.version, materialized: empty };
      }
      await store.recordRejectedProposal({
        layer: target.layer,
        nodeKey: target.nodeKey,
        expectedVersion: 0,
        actor: 'AI_CURATOR',
        reason: args.reason,
        evidence,
      });
      const opsMissing = LAYERS[target.layer].opsOwnedPaths.length > 0 && args.validated?.errors.length === 0;
      return { status: opsMissing ? 'NEEDS_OPS_INPUT' : 'QUARANTINED', version: null, materialized: empty };
    });
  }
}
