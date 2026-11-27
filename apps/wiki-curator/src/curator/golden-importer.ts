import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { canonicalJson, type ClockPort } from '@prometheus/kernel';
import type { SliceCard, VerificationDepth, WikiLayer } from '@prometheus/contracts';
import type { WikiLayerRepository } from '../persistence/wiki-layer-repository.js';
import { openFixture } from './golden-fixture.js';
import { planGoldenImport, type GoldenPlan, type PendingRuling } from './golden-mapping.js';
import { LAYERS, parseFields } from './layers.js';
import { cardCacheKey } from './slice-cards.js';
import type { Materializer, SliceCardCache } from './materializer.js';
import { applyLocks, type LockConflict } from './validators.js';

/**
 * Golden Fixture Importer (ENG-T2 §4): `import-golden --file <abs path>` maps a wiki-v2.0 golden record into
 * all 6 layer tables (`actor = GOLDEN_FIXTURE`) and compiles + caches the Slice Cards.
 *  - all fixture interpretation lives in golden-mapping.ts; any TODO_RULING marker aborts BEFORE any write;
 *  - every node is validated against its Zod layer schema and its own node key;
 *  - one wiki_writer transaction for all nodes, revisions and cards; the DEEP_VERIFIED citation trigger
 *    (GR-AI-007) runs on every row — there is no bypass for fixtures;
 *  - idempotent: an unchanged node is not rewritten (no version bump, no revision); LOCKED_BY_HUMAN pins win.
 */

export class PendingRulingsError extends Error {
  override readonly name = 'PendingRulingsError';
  constructor(
    readonly file: string,
    readonly pending: readonly PendingRuling[],
  ) {
    super(
      `golden import of ${file} blocked by ${pending.length} pending ruling(s):\n${pending
        .map((p) => `  - TODO_RULING ${p.id}: ${p.pointer}`)
        .join('\n')}`,
    );
  }
}

export class GoldenNodeInvalidError extends Error {
  override readonly name = 'GoldenNodeInvalidError';
}

export interface GoldenNodeResult {
  readonly layer: WikiLayer;
  readonly nodeKey: string;
  readonly depth: VerificationDepth;
  readonly status: 'WRITTEN' | 'UNCHANGED';
  readonly version: number;
}

export interface GoldenImportResult {
  readonly file: string;
  readonly compiledKey: string;
  readonly season: string;
  readonly nodes: readonly GoldenNodeResult[];
  readonly cards: readonly SliceCard[];
  readonly lockConflicts: ReadonlyArray<LockConflict & { readonly nodeKey: string }>;
}

export interface GoldenImportDeps {
  readonly layers: WikiLayerRepository;
  readonly materializer: Materializer;
  readonly cards: SliceCardCache;
  readonly clock: ClockPort;
}

export async function readGoldenPlan(path: string): Promise<GoldenPlan> {
  const json: unknown = JSON.parse(await readFile(path, 'utf8'));
  return planGoldenImport(basename(path), openFixture(basename(path), json));
}

/** Throws PendingRulingsError / GoldenNodeInvalidError before touching the database. */
export function assertImportable(plan: GoldenPlan): void {
  if (plan.pending.length > 0) throw new PendingRulingsError(plan.file, plan.pending);
  for (const node of plan.nodes) {
    const descriptor = LAYERS[node.layer];
    const parsed = descriptor.fields.safeParse(node.fields);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new GoldenNodeInvalidError(
        `${plan.file} ${node.layer} ${node.nodeKey}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`,
      );
    }
    const key = descriptor.nodeKeyOf(node.fields);
    if (key !== node.nodeKey)
      throw new GoldenNodeInvalidError(
        `${plan.file} ${node.layer}: node key ${key ?? '?'} != ${node.nodeKey}`,
      );
    if (node.depth === 'DEEP_VERIFIED' && node.citations.length === 0) {
      throw new GoldenNodeInvalidError(
        `${plan.file} ${node.layer} ${node.nodeKey}: DEEP_VERIFIED without citations`,
      );
    }
  }
}

export async function importGolden(deps: GoldenImportDeps, plan: GoldenPlan): Promise<GoldenImportResult> {
  assertImportable(plan);
  const outcome = await deps.layers.transaction(async (store) => {
    const nodes: GoldenNodeResult[] = [];
    const conflicts: Array<LockConflict & { nodeKey: string }> = [];
    for (const node of plan.nodes) {
      const existing = await store.findNode(node.layer, node.nodeKey);
      const locked = applyLocks(
        node.fields,
        existing?.lockedPaths ?? [],
        existing ? { ...existing.fields } : undefined,
      );
      conflicts.push(...locked.conflicts.map((c) => ({ ...c, nodeKey: node.nodeKey })));
      const fields = parseFields(node.layer, locked.effective);
      const same =
        existing !== undefined &&
        canonicalJson({
          f: existing.fields,
          d: existing.depth,
          s: existing.score,
          c: existing.citations,
          sl: existing.slotCompleteness,
          w: existing.wikiStatus,
        }) ===
          canonicalJson({
            f: fields,
            d: node.depth,
            s: node.score,
            c: node.citations,
            sl: node.slots,
            w: node.wikiStatus,
          });
      if (same) {
        nodes.push({
          layer: node.layer,
          nodeKey: node.nodeKey,
          depth: node.depth,
          status: 'UNCHANGED',
          version: existing.version,
        });
        continue;
      }
      const written = await store.writeNode({
        layer: node.layer,
        nodeKey: node.nodeKey,
        fields,
        depth: node.depth,
        score: node.score,
        citations: node.citations,
        slotCompleteness: node.slots,
        wikiStatus: node.wikiStatus,
        lockedPaths: existing?.lockedPaths ?? [],
        expectedVersion: existing?.version ?? 0,
        actor: 'GOLDEN_FIXTURE',
        reason: `golden import ${plan.compiledKey}`,
        verifiedAt: deps.clock.now(),
      });
      nodes.push({
        layer: node.layer,
        nodeKey: node.nodeKey,
        depth: node.depth,
        status: 'WRITTEN',
        version: written.version,
      });
    }
    // 3-view materialisation for every node that feeds a card (programs compile their full 4-card context)
    const cards = new Map<string, SliceCard>();
    for (const node of plan.nodes) {
      if (LAYERS[node.layer].card === undefined) continue;
      const result = await deps.materializer.materialize(store, node.layer, node.nodeKey, plan.season);
      for (const card of result.cards) cards.set(cardCacheKey(card), card);
    }
    return { nodes, conflicts, cards: [...cards.values()] };
  });
  await deps.cards.publish({ cards: outcome.cards, evict: [] });
  return {
    file: plan.file,
    compiledKey: plan.compiledKey,
    season: plan.season,
    nodes: outcome.nodes,
    cards: outcome.cards,
    lockConflicts: outcome.conflicts,
  };
}
