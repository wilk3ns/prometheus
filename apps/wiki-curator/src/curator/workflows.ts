import { DBOS } from '@dbos-inc/dbos-sdk';
import type {
  ModelFamily,
  ModelTier,
  SliceCard,
  VerificationReport,
  WikiLayer,
  WikiNodeProposal,
} from '@prometheus/contracts';
import type { ModelResult } from '@prometheus/ai';
import type { SliceCardCache } from './materializer.js';
import {
  baselineGateDecision,
  retryFeedback,
  type CommitOutcome,
  type CommitStatus,
  type DualPassCurator,
  type Gathered,
  type NodeContext,
  type NodeTarget,
  type Validated,
} from './pipeline.js';
import type { GateDecision } from './publish-gate.js';
import type { LockConflict, ValidationError } from './validators.js';

/**
 * Durable workflows of the curator (ENG-T2 §4), on DBOS Transact:
 *  - WF-03 `WikiDeepVerify`: Agent A (deep_extract) -> deterministic validator -> Agent B (deep_verify, other
 *    family) -> publish gate -> one-transaction commit (+ materializer) -> Valkey cards. At most ONE targeted
 *    retry (Agent A re-run with the fenced validator / verifier feedback); a second failure quarantines.
 *    Single-flight id `wiki-verify:${layer}:${nodeKey}:${season}:${version}`.
 *  - WF-19 `SeasonalBaselineBuild`: per crawl target with a BOUND node key, baseline_extract -> validator ->
 *    deterministic gate (P1) -> BASELINE commit, or quarantine.
 * Both workflows leave DEEP_VERIFIED (WF-19) and QUARANTINED (both, P2) nodes untouched, checked before any
 * model spend. Every step is checkpointed, so a crash resumes after the last completed step.
 */

export type VerifyStatus = CommitStatus | 'ABORTED' | 'UNBOUND_TARGET';

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
  readonly gate: GateDecision | null;
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
  /**
   * Node key BOUND to the target (HIGH-2): `<program_id>:<season>` for PROGRAM targets, an ops-supplied key for
   * other layers. `null` = unbound: the target is skipped (a model never chooses which node it writes).
   */
  readonly nodeKey: string | null;
  /** `crawl_target.country_iso2` */
  readonly countryIso2: string;
}

export function verifyWorkflowId(
  target: Pick<NodeTarget, 'layer' | 'nodeKey' | 'season'>,
  version: number,
): string {
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

  const wf03 = DBOS.registerWorkflow(
    async (target: NodeTarget, expectedVersion: number): Promise<VerifyResult> => {
      const workflowId = verifyWorkflowId(target, expectedVersion);
      const callKey = `verify:${target.layer}:${target.nodeKey}:${workflowId}`;
      const context: NodeContext = await step('load-context', () => curator.loadContext(target));
      const version = context.existing?.version ?? 0;
      const noCards: SliceCard[] = [];
      const noConflicts: LockConflict[] = [];
      const idle = (status: VerifyStatus, abortReason: string | null): VerifyResult => ({
        workflowId,
        lockConflicts: noConflicts,
        cards: noCards,
        status,
        version,
        rounds: 0,
        validatorErrors: [],
        gate: null,
        agentA: null,
        agentB: null,
        agentBCalls: 0,
        costUsd: 0,
        abortReason,
      });
      // single-flight is per node version: a node that moved on needs a new workflow id
      if (version !== expectedVersion)
        return idle('ABORTED', `node is at version ${version}, not ${expectedVersion}`);
      // P2: quarantine is sticky; only a human / ops action clears it (no model spend)
      if (context.existing?.depth === 'QUARANTINED') return idle('KEPT_QUARANTINED', null);

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
            ...idle('ABORTED', `agent A ${a.outcome}: ${a.detail}`),
            rounds: round,
            agentA,
            agentB,
            agentBCalls,
            costUsd: cost,
          };
        }
        agentA = { family: a.served.family, tier: a.served.tier };
        const validated: Validated = await step(`validate-${round}`, () =>
          Promise.resolve(curator.validate(target, a.value, gathered, context)),
        );
        const finish = async (
          mode: 'DEEP_VERIFIED' | 'QUARANTINE',
          gate: GateDecision,
          report: VerificationReport | null,
        ): Promise<VerifyResult> => {
          const outcome: CommitOutcome = await step('commit', () =>
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
          await step('cache-cards', () => cards.publish(outcome.materialized));
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
            ...idle('ABORTED', `agent B ${b.outcome}: ${b.detail}`),
            rounds: round,
            validatorErrors: validated.errors,
            agentA,
            agentB,
            agentBCalls,
            costUsd: cost,
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
      const skip = (
        spec: BaselineTargetSpec,
        status: VerifyStatus,
        abortReason: string | null,
      ): BaselineTargetResult => ({
        targetKey: spec.targetKey,
        nodeKey: spec.nodeKey,
        status,
        validatorErrors: [],
        gate: null,
        abortReason,
      });
      for (const [i, spec] of targets.entries()) {
        if (spec.nodeKey === null) {
          results.push(
            skip(spec, 'UNBOUND_TARGET', 'no node key bound to this target (ops must configure it)'),
          );
          continue;
        }
        const target: NodeTarget = {
          layer: spec.layer,
          nodeKey: spec.nodeKey,
          season,
          targetKey: spec.targetKey,
          countryIso2: spec.countryIso2,
        };
        const context = await step(`load-context-${i}`, () => curator.loadContext(target));
        if (context.existing?.depth === 'DEEP_VERIFIED') {
          results.push(skip(spec, 'KEPT_DEEP_VERIFIED', null));
          continue;
        }
        if (context.existing?.depth === 'QUARANTINED') {
          results.push(skip(spec, 'KEPT_QUARANTINED', null)); // P2
          continue;
        }
        const gathered = await step(`gather-${i}`, () =>
          curator.gather(spec.targetKey, `${workflowId}:${i}`),
        );
        const a = await step(`extract-${i}`, () =>
          curator.extract('RTE-wiki.baseline_extract', target, gathered, null, {
            idempotencyKey: `${workflowId}:${i}:extract`,
            callKey: `baseline:${spec.targetKey}:${workflowId}`,
          }),
        );
        if (!a.ok) {
          results.push(skip(spec, 'ABORTED', `${a.outcome}: ${a.detail}`));
          continue;
        }
        const validated = await step(`validate-${i}`, () =>
          Promise.resolve(curator.validate(target, a.value, gathered, context)),
        );
        // P1: the deterministic gate (citations on every required path, no required abstention)
        const gate = baselineGateDecision(target, validated, a.value);
        const outcome = await step(`commit-${i}`, () =>
          curator.commit({
            target,
            mode: gate.pass ? 'BASELINE' : 'QUARANTINE',
            expectedVersion: context.existing?.version ?? 0,
            proposal: a.value,
            validated,
            report: null,
            gathered,
            reason: gate.pass
              ? `WF-19 ${workflowId}: baseline`
              : `WF-19 ${workflowId}: ${gate.failures.join(',')}`,
          }),
        );
        await step(`cache-cards-${i}`, () => cards.publish(outcome.materialized));
        results.push({
          targetKey: spec.targetKey,
          nodeKey: target.nodeKey,
          status: outcome.status,
          validatorErrors: validated.errors,
          gate,
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
