import type { AiSubsystem, CallOutcome, RouteId } from '@prometheus/contracts';

/**
 * Cost control port of the ModelRouter (ENG-T2 §3.3): an atomic per-callKey USD reservation
 * (`econ.call_budget`) and an append-only usage ledger (`econ.ai_usage_ledger`).
 *
 * Invariant (proved by the concurrency property IT): for one callKey the reserved/settled total never exceeds
 * `cap_usd`, however many attempts, retries or parallel callers race. The reservation is a single
 * conditional UPDATE (`... WHERE reserved_usd + amount <= cap_usd`), so Postgres row locking serialises it.
 */
export interface UsageRecord {
  readonly idempotencyKey: string;
  readonly callKey: string | null;
  readonly subsystem: AiSubsystem;
  readonly route: RouteId;
  readonly provider: string;
  readonly family: 'openai-gpt' | 'google-gemini' | 'replay';
  readonly modelOrSku: string;
  readonly promptId: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly latencyMs: number;
  readonly outcome: CallOutcome;
}

export interface EconomicsPort {
  /** Atomically reserves `amountUsd` under `callKey` (created with `capUsd` on first use). */
  reserve(callKey: string, route: RouteId, capUsd: number, amountUsd: number): Promise<boolean>;
  /** Replaces a reservation by the metered cost (clamped so the total never exceeds the cap). */
  settle(callKey: string, reservedUsd: number, actualUsd: number): Promise<void>;
  /** Appends one ledger row; idempotent on `idempotencyKey` (a replayed workflow step never double-counts). */
  record(usage: UsageRecord): Promise<void>;
}

/** Formats a USD amount for `numeric(10,6)` columns without float drift. */
export function usd6(amount: number): string {
  if (!Number.isFinite(amount) || amount < 0) throw new RangeError(`invalid USD amount ${amount}`);
  return (Math.ceil(amount * 1_000_000) / 1_000_000).toFixed(6);
}
