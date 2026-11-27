import type { VerificationReport } from '@prometheus/contracts';
import { pathsOverlap } from './paths.js';
import type { ValidationError } from './validators.js';

/**
 * Publish gate (ENG-T2 §4 step 5, GR-AI-010). Pure function: the ONLY thing that can promote a node to
 * DEEP_VERIFIED. Neither agent decides; the gate reads their outputs as evidence.
 *   PASS  <=>  0 post-validator errors
 *          && an Agent B report exists with 0 discrepancies and verification_score >= 0.950
 *          && checked_paths covers every required path
 *          && no required path was abstained on.
 */
export const DEEP_VERIFIED_MIN_SCORE = 0.95;

export interface GateInput {
  readonly validatorErrors: readonly ValidationError[];
  readonly report: VerificationReport | undefined;
  readonly requiredPaths: readonly string[];
  readonly abstainFields: readonly string[];
}

export type GateFailure =
  | 'POST_VALIDATOR_ERRORS'
  | 'NO_VERIFICATION_REPORT'
  | 'DISCREPANCIES'
  | 'SCORE_BELOW_THRESHOLD'
  | 'REQUIRED_PATHS_UNCHECKED'
  | 'REQUIRED_PATHS_ABSTAINED';

export interface GateDecision {
  readonly pass: boolean;
  readonly failures: readonly GateFailure[];
  readonly uncheckedPaths: readonly string[];
  readonly abstainedRequired: readonly string[];
}

export function decidePublish(input: GateInput): GateDecision {
  const failures: GateFailure[] = [];
  if (input.validatorErrors.length > 0) failures.push('POST_VALIDATOR_ERRORS');
  // hierarchy-aware: abstaining on `program` abstains on `program.degree_level` and vice versa (HIGH-1)
  const abstainedRequired = input.requiredPaths.filter((p) =>
    input.abstainFields.some((a) => pathsOverlap(a, p)),
  );
  if (abstainedRequired.length > 0) failures.push('REQUIRED_PATHS_ABSTAINED');
  let uncheckedPaths: string[] = [...input.requiredPaths];
  if (input.report === undefined) {
    failures.push('NO_VERIFICATION_REPORT');
  } else {
    const checked = input.report.checked_paths;
    // a checked ancestor covers its descendants; a checked child does not cover the whole parent
    uncheckedPaths = input.requiredPaths.filter(
      (p) => !checked.some((c) => c === p || p.startsWith(`${c}.`)),
    );
    if (input.report.discrepancies.length > 0) failures.push('DISCREPANCIES');
    if (!(input.report.verification_score >= DEEP_VERIFIED_MIN_SCORE)) failures.push('SCORE_BELOW_THRESHOLD');
    if (uncheckedPaths.length > 0) failures.push('REQUIRED_PATHS_UNCHECKED');
  }
  return { pass: failures.length === 0, failures, uncheckedPaths, abstainedRequired };
}

/**
 * Deterministic part of the gate, for BASELINE commits (WF-19, no Agent B): 0 validator errors (which include
 * REQUIRED_PATH_UNCITED) and no required-path abstention. Failing it means the node is never matchable (P1).
 */
export function decideBaselinePublish(input: Omit<GateInput, 'report'>): GateDecision {
  const full = decidePublish({ ...input, report: undefined });
  const failures = full.failures.filter((f) => f !== 'NO_VERIFICATION_REPORT');
  return {
    pass: failures.length === 0,
    failures,
    uncheckedPaths: [],
    abstainedRequired: full.abstainedRequired,
  };
}
