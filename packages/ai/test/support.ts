import type { ModelFamily, RouteId } from '@prometheus/contracts';
import type { EconomicsPort, UsageRecord } from '../src/econ/economics.js';
import type {
  EmbedResponse,
  GenerateRequest,
  GenerateResponse,
  ModelAdapterPort,
} from '../src/adapters/types.js';

/** In-memory EconomicsPort with the same cap semantics as the Postgres implementation. */
export class MemoryEconomics implements EconomicsPort {
  readonly budgets = new Map<string, { cap: number; reserved: number; attempts: number }>();
  readonly ledger: UsageRecord[] = [];

  reserve(callKey: string, _route: RouteId, capUsd: number, amountUsd: number): Promise<boolean> {
    const b = this.budgets.get(callKey) ?? { cap: capUsd, reserved: 0, attempts: 0 };
    this.budgets.set(callKey, b);
    if (b.reserved + amountUsd > b.cap + 1e-12) return Promise.resolve(false);
    b.reserved += amountUsd;
    b.attempts += 1;
    return Promise.resolve(true);
  }

  settle(callKey: string, reservedUsd: number, actualUsd: number): Promise<void> {
    const b = this.budgets.get(callKey);
    if (b) b.reserved = Math.min(b.cap, Math.max(0, b.reserved - reservedUsd + actualUsd));
    return Promise.resolve();
  }

  record(usage: UsageRecord): Promise<void> {
    if (!this.ledger.some((u) => u.idempotencyKey === usage.idempotencyKey)) this.ledger.push(usage);
    return Promise.resolve();
  }
}

/** Scripted adapter of one family: answers per call from a queue (or a function). Records every request. */
export class ScriptedAdapter implements ModelAdapterPort {
  readonly provider: string;
  readonly ledgerFamily: ModelFamily;
  readonly requests: GenerateRequest[] = [];

  constructor(
    family: ModelFamily,
    private readonly respond: (req: GenerateRequest) => GenerateResponse,
    readonly piiApproved = false,
  ) {
    this.ledgerFamily = family;
    this.provider = `scripted-${family}`;
  }

  generate(request: GenerateRequest): Promise<GenerateResponse> {
    this.requests.push(request);
    return Promise.resolve(this.respond(request));
  }

  embed(): Promise<EmbedResponse> {
    return Promise.resolve({ kind: 'ERROR', detail: 'not scripted' });
  }
}

export const okJson = (value: unknown, inputTokens = 1_000, outputTokens = 200): GenerateResponse => ({
  kind: 'OK',
  text: JSON.stringify(value),
  inputTokens,
  outputTokens,
});
