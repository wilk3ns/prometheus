import { DBOS } from '@dbos-inc/dbos-sdk';
import type { ModelFamily, ModelTier, SliceCard, WikiLayer, WikiNodeProposal } from '@prometheus/contracts';
import type { ModelResult } from '@prometheus/ai';
import type { SliceCardCache } from './materializer.js';
import {
  retryFeedback,
  type CommitOutcome,
  type CommitStatus,
  type DualPassCurator,
  type ExistingView,
  type Gathered,
  type NodeTarget,
  type Validated,
} from './pipeline.js';
import type { GateDecision } from './publish-gate.js';
import type { LockConflict, ValidationError } from './validators.js';

/**
 * Durable workflows of the curator (ENG-T2 §4), on DBOS Transact:
 *  - WF-03 `WikiDeepVerify`: Agent A (deep_extract) -> deterministic validator -> Agent B (deep_verify, other
 *    family) -> publish gate -> one-transaction commit (+ materializer) -> Valkey cards. At most ONE targeted
 *    retry (Agent A re-run with the validator / verifier feedback); a second failure quarantines.
 *    Single-flight id `wiki-verify:${layer}:${nodeKey}:${season}:${version}`: concurrent requests for the same
 *    node version join one execution, and a completed id returns its recorded result.
 *  - WF-19 `SeasonalBaselineBuild`: per crawl target, baseline_extract -> validator -> BASELINE commit; never
 *    touches DEEP_VERIFIED nodes.
 * Every step is checkpointed, so a crash resumes after the last completed step (model calls are not repeated
 * once recorded, and ledger/budget writes are idempotent per step key).
 */

export type VerifyStatus = CommitStatus | 'ABORTED';

export interface VerifyResult {
  readonly workflowId: string;
  readonly status: VerifyStatus;
  readonly version: number | null;
  readonly rounds: number;
  readonly lockConflicts: readonly LockConflict[];
  readonly validatorErrors: readonly ValidationError[];
  readonly gate: GateDecision | null;
  readonly agentA: { readonly family: ModelFamily; readonly tier: ModelTier } | null;
  readonly agentB: { readonly family: ModelFamily; readonly tier: ModelTier } | null;
  readonly agentBCalls: number;
  readonly costUsd: number;
  readonly abortReason: string | null;
  readonly cards: readonly SliceCard[];
}

export interface BaselineTargetResult {
  readonly targetKey: string;
  readonly nodeKey: string | null;
  readonly status: VerifyStatus;
  readonly validatorErrors: readonly ValidationError[];
  readonly abortReason: string | null;
}

export interface BaselineResult {
  readonly workflowId: string;
  readonly season: string;
  readonly targets: readonly BaselineTargetResult[];
}

export interface BaselineTargetSpec {
  readonly targetKey: string;
  readonly layer: WikiLayer;
  /** Known up front for PROGRAM targets (`<program_id>:<season>`); otherwise taken from the proposal. */
  readonly nodeKey: string | null;
}

export function verifyWorkflowId(target: NodeTarget, version: number): string {
  return `wiki-verify:${target.layer}:${target.nodeKey}:${target.season}:${version}`;
}

export function baselineWorkflowId(season: string, batchId: string): string {
  return `wiki-baseline:${season}:${batchId}`;
}

export interface CuratorWorkflows {
  /** Starts (or joins) WF-03 for `target` at the node's current version and waits for its result. */
  verify(target: NodeTarget, currentVersion: number): Promise<VerifyResult>;
  baseline(season: string, batchId: string, targets: readonly BaselineTargetSpec[]): Promise<BaselineResult>;
}

/** Registers WF-03 and WF-19 against the given curator. Call once per process, before `launchDurable`. */
export function registerCuratorWorkflows(curator: DualPassCurator, cards: SliceCardCache): CuratorWorkflows {
  const step = <T>(name: string, fn: () => Promise<T>): Promise<T> => DBOS.runStep(fn, { name });

  const publishCards = (outcome: CommitOutcome): Promise<void> =>
    step('cache-cards', () => cards.publish(outcome.materialized));

  const wf03 = DBOS.registerWorkflow(
    async (target: NodeTarget, expectedVersion: number): Promise<VerifyResult> => {
      const workflowId = verifyWorkflowId(target, expectedVersion);
      const callKey = `verify:${target.layer}:${target.nodeKey}:${workflowId}`;
      const existing: ExistingView | null = await step('load-existing', () =>
        curator.loadExisting(target.layer, target.nodeKey),
      );
      const version = existing?.version ?? 0;
      const noCards: SliceCard[] = [];
      const noConflicts: LockConflict[] = [];
      const base = { workflowId, lockConflicts: noConflicts, cards: noCards };
      if (version !== expectedVersion) {
        // single-flight is per node version: a node that moved on needs a new workflow id
        return {
          ...base,
          status: 'ABORTED',
          version,
          rounds: 0,
          validatorErrors: [],
          gate: null,
          agentA: null,
          agentB: null,
          agentBCalls: 0,
          costUsd: 0,
          abortReason: `node is at version ${version}, not ${expectedVersion}`,
        };
      }
      const gathered: Gathered = await step('gather', () => curator.gather(target.targetKey, workflowId));
      let feedback: string | null = null;
      let cost = 0;
      let agentBCalls = 0;
      let agentA: VerifyResult['agentA'] = null;
      let agentB: VerifyResult['agentB'] = null;

      for (let round = 1; round <= 2; round += 1) {
        const a: ModelResult<WikiNodeProposal> = await step(`agent-a-${round}`, () =>
          curator.extract('RTE-wiki.deep_extract', target, gathered, feedback, {
            idempotencyKey: `${workflowId}:agent-a:${round}`,
            callKey,
          }),
        );
        cost += a.costUsd;
        if (!a.ok) {
          return {
            ...base,
            status: 'ABORTED',
            version,
            rounds: round,
            validatorErrors: [],
            gate: null,
            agentA,
            agentB,
            agentBCalls,
            costUsd: cost,
            abortReason: `agent A ${a.outcome}: ${a.detail}`,
          };
        }
        agentA = { family: a.served.family, tier: a.served.tier };
        const validated: Validated = await step(`validate-${round}`, () =>
          Promise.resolve(curator.validate(target, a.value, gathered, existing)),
        );
        const finish = async (
          mode: 'DEEP_VERIFIED' | 'QUARANTINE',
          gate: GateDecision,
          report: VerificationReportOrNull,
        ): Promise<VerifyResult> => {
          const outcome = await step('commit', () =>
            curator.commit({
              target,
              mode,
              expectedVersion: version,
              proposal: a.value,
              validated,
              report,
              gathered,
              reason:
                mode === 'DEEP_VERIFIED'
                  ? `WF-03 ${workflowId}: publish gate PASS`
                  : `WF-03 ${workflowId}: ${gate.failures.join(',')}`,
            }),
          );
          await publishCards(outcome);
          return {
            workflowId,
            status: outcome.status,
            version: outcome.version,
            rounds: round,
            lockConflicts: validated.lockConflicts,
            validatorErrors: validated.errors,
            gate,
            agentA,
            agentB,
            agentBCalls,
            costUsd: cost,
            abortReason: null,
            cards: outcome.materialized.cards,
          };
        };

        if (validated.errors.length > 0 || validated.fields === null) {
          // deterministic failure: Agent B is never paid for a proposal the validator already rejected
          const gate = curator.gate(target, validated, a.value, undefined);
          if (round === 1) {
            feedback = retryFeedback(validated, gate, undefined);
            continue;
          }
          return finish('QUARANTINE', gate, null);
        }

        const b = await step(`agent-b-${round}`, () =>
          curator.verify(target, gathered, a.value, validated.fields ?? {}, a.served.family, {
            idempotencyKey: `${workflowId}:agent-b:${round}`,
            callKey,
          }),
        );
        agentBCalls += 1;
        cost += b.costUsd;
        if (!b.ok) {
          return {
            ...base,
            status: 'ABORTED',
            version,
            rounds: round,
            validatorErrors: validated.errors,
            gate: null,
            agentA,
            agentB,
            agentBCalls,
            costUsd: cost,
            abortReason: `agent B ${b.outcome}: ${b.detail}`,
          };
        }
        agentB = { family: b.served.family, tier: b.served.tier };
        const gate = curator.gate(target, validated, a.value, b.value);
        if (gate.pass) return finish('DEEP_VERIFIED', gate, b.value);
        if (round === 1) {
          feedback = retryFeedback(validated, gate, b.value);
          continue;
        }
        return finish('QUARANTINE', gate, b.value);
      }
      throw new Error('unreachable: WF-03 loop always returns');
    },
    { name: 'WF-03.WikiDeepVerify' },
  );

  const wf19 = DBOS.registerWorkflow(
    async (
      season: string,
      batchId: string,
      targets: readonly BaselineTargetSpec[],
    ): Promise<BaselineResult> => {
      const workflowId = baselineWorkflowId(season, batchId);
      const results: BaselineTargetResult[] = [];
      for (const [i, spec] of targets.entries()) {
        const gathered = await step(`gather-${i}`, () =>
          curator.gather(spec.targetKey, `${workflowId}:${i}`),
        );
        const provisional: NodeTarget = {
          layer: spec.layer,
          nodeKey: spec.nodeKey ?? '',
          season,
          targetKey: spec.targetKey,
        };
        const a = await step(`extract-${i}`, () =>
          curator.extract('RTE-wiki.baseline_extract', provisional, gathered, null, {
            idempotencyKey: `${workflowId}:${i}:extract`,
            callKey: `baseline:${spec.targetKey}:${workflowId}`,
          }),
        );
        if (!a.ok) {
          results.push({
            targetKey: spec.targetKey,
            nodeKey: spec.nodeKey,
            status: 'ABORTED',
            validatorErrors: [],
            abortReason: `${a.outcome}: ${a.detail}`,
          });
          continue;
        }
        const target: NodeTarget = { ...provisional, nodeKey: spec.nodeKey ?? a.value.node_key };
        const existing = await step(`load-existing-${i}`, () =>
          curator.loadExisting(target.layer, target.nodeKey),
        );
        if (existing?.depth === 'DEEP_VERIFIED') {
          results.push({
            targetKey: spec.targetKey,
            nodeKey: target.nodeKey,
            status: 'KEPT_DEEP_VERIFIED',
            validatorErrors: [],
            abortReason: null,
          });
          continue;
        }
        const validated = await step(`validate-${i}`, () =>
          Promise.resolve(curator.validate(target, a.value, gathered, existing)),
        );
        const ok = validated.errors.length === 0 && validated.fields !== null;
        const outcome = await step(`commit-${i}`, () =>
          curator.commit({
            target,
            mode: ok ? 'BASELINE' : 'QUARANTINE',
            expectedVersion: existing?.version ?? 0,
            proposal: a.value,
            validated,
            report: null,
            gathered,
            reason: ok ? `WF-19 ${workflowId}: baseline` : `WF-19 ${workflowId}: validator rejected`,
          }),
        );
        await step(`cache-cards-${i}`, () => cards.publish(outcome.materialized));
        results.push({
          targetKey: spec.targetKey,
          nodeKey: target.nodeKey,
          status: outcome.status,
          validatorErrors: validated.errors,
          abortReason: null,
        });
      }
      return { workflowId, season, targets: results };
    },
    { name: 'WF-19.SeasonalBaselineBuild' },
  );

  return {
    async verify(target, currentVersion) {
      const handle = await DBOS.startWorkflow(wf03, { workflowID: verifyWorkflowId(target, currentVersion) })(
        target,
        currentVersion,
      );
      return handle.getResult();
    },
    async baseline(season, batchId, targets) {
      const handle = await DBOS.startWorkflow(wf19, { workflowID: baselineWorkflowId(season, batchId) })(
        season,
        batchId,
        targets,
      );
      return handle.getResult();
    },
  };
}

type VerificationReportOrNull = Parameters<DualPassCurator['commit']>[0]['report'];
