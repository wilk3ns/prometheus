import type { CallOutcome, DataClass, ModelFamily, ModelTier, RouteId } from '@prometheus/contracts';
import { canonicalJson, sha256Hex } from '@prometheus/kernel';
import { z } from 'zod';
import type { CassetteKeyMaterial, ModelAdapterPort } from './adapters/types.js';
import { CATALOG, EMBEDDING_DIMENSIONS, costUsd, estimateTokens, type TierSpec } from './catalog.js';
import type { EconomicsPort } from './econ/economics.js';
import { assertVariables, loadPrompt, renderTemplate, type LoadedPrompt } from './prompts/registry.js';
import { ROUTES, type RouteSpec } from './routes.js';
import {
  cryptoNonce,
  renderUntrustedBlock,
  sanitizeUntrusted,
  type NonceSource,
  type UntrustedDocument,
} from './untrusted.js';

/**
 * Cross-family ModelRouter (ENG-T2 §3). The ONLY way any module talks to a model. Per call:
 *  1. policy: the data class must be allowed by the route; `deep_verify` requires `excludeFamily`;
 *     candidates (primary, then fallback) of the excluded family are rejected (POLICY_DENIED) and NEVER
 *     failed over to (GR-AI-009); APPLICANT_PII only reaches endpoints approved for it;
 *  2. prompt: versioned, hash-locked template; untrusted documents fenced with a fresh 128-bit nonce;
 *  3. budget: worst-case USD reserved atomically under the call key before the adapter is invoked, settled
 *     with the metered cost afterwards; a refused reservation is a BUDGET outcome (no model call);
 *  4. output: JSON-parsed and Zod-validated; one repair retry on schema failure; ERROR / DEADLINE fail over
 *     to the next permitted candidate;
 *  5. every attempt (including denials) writes one `econ.ai_usage_ledger` row.
 * The parsed value is still untrusted: callers run deterministic validators before anything is persisted.
 */

export interface GenerateCall<T> {
  readonly route: RouteId;
  readonly dataClass: DataClass;
  /** Stable per logical call (workflow id + step); ledger rows are idempotent on it. */
  readonly idempotencyKey: string;
  /** Budget key shared by calls that must fit one cap (e.g. deep_extract + deep_verify). Defaults to idempotencyKey. */
  readonly callKey?: string;
  readonly excludeFamily?: ModelFamily;
  /** Caller template variables (must match the prompt's placeholders exactly). */
  readonly vars: Readonly<Record<string, unknown>>;
  readonly untrusted?: readonly UntrustedDocument[];
  readonly schema: z.ZodType<T>;
  readonly schemaName: string;
}

export interface EmbedCall {
  readonly dataClass: DataClass;
  readonly idempotencyKey: string;
  readonly text: string;
}

export interface Served {
  readonly family: ModelFamily;
  readonly tier: ModelTier;
  readonly model: string;
  readonly provider: string;
}

export interface AttemptRecord {
  readonly tier: ModelTier;
  readonly family: ModelFamily;
  readonly outcome: CallOutcome;
  readonly detail: string;
  readonly costUsd: number;
}

export type FailureOutcome = Exclude<CallOutcome, 'OK'>;

export type ModelResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly served: Served;
      readonly costUsd: number;
      readonly attempts: readonly AttemptRecord[];
    }
  | {
      readonly ok: false;
      readonly outcome: FailureOutcome;
      readonly detail: string;
      readonly costUsd: number;
      readonly attempts: readonly AttemptRecord[];
    };

export type EmbedResult =
  | {
      readonly ok: true;
      readonly embedding: readonly number[];
      readonly served: Served;
      readonly costUsd: number;
    }
  | { readonly ok: false; readonly outcome: FailureOutcome; readonly detail: string };

export interface ModelRouterDeps {
  /** Adapter per LOGICAL family (both point at the replay adapter in AI_MODE=replay). */
  readonly adapters: Readonly<Record<ModelFamily, ModelAdapterPort>>;
  readonly economics: EconomicsPort;
  readonly nonce?: NonceSource;
  readonly nowMs?: () => number;
}

/** Repair retries per candidate after a schema-invalid output (ENG-T2 §3 "repair retry"). */
const MAX_REPAIRS = 1;

/** Hash of the caller-visible input: template variables + sanitised untrusted documents (nonce excluded). */
export function inputHashOf(
  vars: Readonly<Record<string, unknown>>,
  untrusted: readonly UntrustedDocument[],
  repair: string | null,
): string {
  return sha256Hex(
    canonicalJson({
      vars,
      untrusted: untrusted.map((d) => ({ kind: d.kind, url: d.url, text: sanitizeUntrusted(d.text) })),
      repair,
    }),
  );
}

/** The cassette key material a call will use on `tier` (shared with cassette synthesis tooling). */
export function cassetteMaterialFor(
  call: Pick<GenerateCall<unknown>, 'route' | 'excludeFamily' | 'vars' | 'untrusted'>,
  tier: ModelTier,
  repair: string | null = null,
): CassetteKeyMaterial {
  const route = ROUTES[call.route];
  if (route.promptId === undefined) throw new Error(`${call.route} has no prompt`);
  return {
    route: call.route,
    promptHash: loadPrompt(route.promptId).sha256,
    tier,
    excludeFamily: call.excludeFamily ?? null,
    inputHash: inputHashOf(call.vars, call.untrusted ?? [], repair),
  };
}

const jsonSchemas = new WeakMap<z.ZodType, Record<string, unknown>>();
function jsonSchemaOf(schema: z.ZodType): Record<string, unknown> {
  let js = jsonSchemas.get(schema);
  if (!js) {
    js = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' });
    jsonSchemas.set(schema, js);
  }
  return js;
}

function parseOutput<T>(
  schema: z.ZodType<T>,
  text: string,
): { ok: true; value: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'output is not valid JSON' };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 10)
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
  return { ok: false, error: issues };
}

export class ModelRouter {
  private readonly nonce: NonceSource;
  private readonly nowMs: () => number;

  constructor(private readonly deps: ModelRouterDeps) {
    this.nonce = deps.nonce ?? cryptoNonce;
    this.nowMs = deps.nowMs ?? Date.now;
  }

  private candidates(route: RouteSpec): TierSpec[] {
    return [route.primary, route.fallback]
      .filter((t): t is ModelTier => t !== undefined)
      .map((t) => CATALOG[t]);
  }

  async generate<T>(call: GenerateCall<T>): Promise<ModelResult<T>> {
    const route = ROUTES[call.route];
    const attempts: AttemptRecord[] = [];
    let ledgerSeq = 0;
    let totalCost = 0;
    const prompt: LoadedPrompt | undefined =
      route.promptId === undefined ? undefined : loadPrompt(route.promptId);
    const callKey = call.callKey ?? call.idempotencyKey;

    const record = async (
      spec: TierSpec,
      adapter: ModelAdapterPort,
      outcome: CallOutcome,
      detail: string,
      usage: { input: number; output: number; cost: number; latencyMs: number },
    ): Promise<void> => {
      ledgerSeq += 1;
      attempts.push({ tier: spec.tier, family: spec.family, outcome, detail, costUsd: usage.cost });
      await this.deps.economics.record({
        idempotencyKey: `${call.idempotencyKey}#${ledgerSeq}`,
        callKey,
        subsystem: route.subsystem,
        route: route.id,
        provider: adapter.provider,
        family: adapter.ledgerFamily,
        modelOrSku: adapter.ledgerFamily === 'replay' ? `replay:${spec.model}` : spec.model,
        promptId: prompt?.id ?? 'none',
        promptVersion: prompt?.version ?? '0',
        promptHash: prompt?.sha256 ?? sha256Hex('none'),
        inputTokens: usage.input,
        outputTokens: usage.output,
        estimatedCostUsd: usage.cost,
        latencyMs: usage.latencyMs,
        outcome,
      });
    };
    const fail = (outcome: FailureOutcome, detail: string): ModelResult<T> => ({
      ok: false,
      outcome,
      detail,
      costUsd: totalCost,
      attempts,
    });
    const zero = { input: 0, output: 0, cost: 0, latencyMs: 0 };

    if (prompt === undefined) return fail('POLICY_DENIED', `${route.id} is not a generation route`);
    if (!route.allowedDataClasses.includes(call.dataClass)) {
      return fail('POLICY_DENIED', `${call.dataClass} is not allowed on ${route.id}`);
    }
    if (route.requiresExcludeFamily && call.excludeFamily === undefined) {
      return fail('POLICY_DENIED', `${route.id} requires excludeFamily (GR-AI-009)`);
    }
    assertVariables(prompt, call.vars);

    let lastFailure: { outcome: FailureOutcome; detail: string } = {
      outcome: 'POLICY_DENIED',
      detail: 'no permitted candidate',
    };
    for (const spec of this.candidates(route)) {
      const adapter = this.deps.adapters[spec.family];
      if (call.excludeFamily === spec.family) {
        await record(spec, adapter, 'POLICY_DENIED', `family ${spec.family} excluded (GR-AI-009)`, zero);
        continue;
      }
      if (call.dataClass === 'APPLICANT_PII' && !adapter.piiApproved) {
        await record(
          spec,
          adapter,
          'POLICY_DENIED',
          `${adapter.provider} not approved for APPLICANT_PII`,
          zero,
        );
        continue;
      }

      let repair: string | null = null;
      for (let repairs = 0; ; repairs += 1) {
        const nonce = this.nonce();
        const untrusted = renderUntrustedBlock(call.untrusted ?? [], nonce);
        const system = renderTemplate(prompt.system, call.vars, { nonce, untrusted });
        const baseUser = renderTemplate(prompt.userTemplate, call.vars, { nonce, untrusted });
        const user =
          repair === null
            ? baseUser
            : `${baseUser}\n\nYOUR PREVIOUS OUTPUT FAILED SCHEMA VALIDATION: ${repair}\nReturn corrected JSON only.`;
        const reservation = costUsd(spec, estimateTokens(system + user), route.maxOutputTokens);
        if (!(await this.deps.economics.reserve(callKey, route.id, route.costCapUsd, reservation))) {
          await record(
            spec,
            adapter,
            'BUDGET',
            `reservation ${reservation} USD exceeds cap on ${callKey}`,
            zero,
          );
          return fail('BUDGET', `call budget exhausted for ${callKey}`);
        }
        const started = this.nowMs();
        const response = await adapter.generate({
          model: spec.model,
          system,
          user,
          jsonSchema: jsonSchemaOf(call.schema),
          schemaName: call.schemaName,
          maxOutputTokens: route.maxOutputTokens,
          signal: AbortSignal.timeout(route.timeoutMs),
          cassette: cassetteMaterialFor(call, spec.tier, repair),
        });
        const latencyMs = this.nowMs() - started;
        const metered =
          response.kind === 'OK' ? costUsd(spec, response.inputTokens, response.outputTokens) : 0;
        await this.deps.economics.settle(callKey, reservation, metered);
        totalCost += metered;
        const usage = {
          input: response.kind === 'OK' ? response.inputTokens : 0,
          output: response.kind === 'OK' ? response.outputTokens : 0,
          cost: metered,
          latencyMs,
        };

        if (response.kind === 'REFUSED') {
          await record(spec, adapter, 'ABSTAIN', response.detail, usage);
          return fail('ABSTAIN', response.detail);
        }
        if (response.kind === 'TIMEOUT' || response.kind === 'ERROR') {
          const outcome = response.kind === 'TIMEOUT' ? 'DEADLINE' : 'ERROR';
          await record(spec, adapter, outcome, response.detail, usage);
          lastFailure = { outcome, detail: response.detail };
          break; // fail over to the next permitted candidate
        }
        const parsed = parseOutput(call.schema, response.text);
        if (parsed.ok) {
          await record(spec, adapter, 'OK', '', usage);
          return {
            ok: true,
            value: parsed.value,
            served: { family: spec.family, tier: spec.tier, model: spec.model, provider: adapter.provider },
            costUsd: totalCost,
            attempts,
          };
        }
        await record(spec, adapter, 'SCHEMA_INVALID', parsed.error, usage);
        if (repairs >= MAX_REPAIRS) return fail('SCHEMA_INVALID', parsed.error);
        repair = parsed.error;
      }
    }
    return fail(lastFailure.outcome, lastFailure.detail);
  }

  async embed(call: EmbedCall): Promise<EmbedResult> {
    const route = ROUTES['RTE-matching.embed'];
    if (!route.allowedDataClasses.includes(call.dataClass)) {
      return { ok: false, outcome: 'POLICY_DENIED', detail: `${call.dataClass} not allowed on ${route.id}` };
    }
    const spec = CATALOG[route.primary];
    const adapter = this.deps.adapters[spec.family];
    if (call.dataClass === 'APPLICANT_PII' && !adapter.piiApproved) {
      return {
        ok: false,
        outcome: 'POLICY_DENIED',
        detail: `${adapter.provider} not approved for APPLICANT_PII`,
      };
    }
    const reservation = costUsd(spec, estimateTokens(call.text), 0);
    const promptHash = sha256Hex(`embed:${spec.model}:${EMBEDDING_DIMENSIONS}`);
    const base = {
      idempotencyKey: `${call.idempotencyKey}#1`,
      callKey: call.idempotencyKey,
      subsystem: route.subsystem,
      route: route.id,
      provider: adapter.provider,
      family: adapter.ledgerFamily,
      modelOrSku: adapter.ledgerFamily === 'replay' ? `replay:${spec.model}` : spec.model,
      promptId: 'embed.raw',
      promptVersion: '1',
      promptHash,
    } as const;
    if (!(await this.deps.economics.reserve(call.idempotencyKey, route.id, route.costCapUsd, reservation))) {
      await this.deps.economics.record({
        ...base,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        latencyMs: 0,
        outcome: 'BUDGET',
      });
      return { ok: false, outcome: 'BUDGET', detail: 'embedding budget exhausted' };
    }
    const started = this.nowMs();
    const response = await adapter.embed({
      model: spec.model,
      input: call.text,
      dimensions: EMBEDDING_DIMENSIONS,
      signal: AbortSignal.timeout(route.timeoutMs),
      cassette: {
        route: route.id,
        promptHash,
        tier: spec.tier,
        excludeFamily: null,
        inputHash: sha256Hex(call.text),
      },
    });
    const metered = response.kind === 'OK' ? costUsd(spec, response.inputTokens, 0) : 0;
    await this.deps.economics.settle(call.idempotencyKey, reservation, metered);
    const usage = {
      ...base,
      inputTokens: response.kind === 'OK' ? response.inputTokens : 0,
      outputTokens: 0,
      estimatedCostUsd: metered,
      latencyMs: this.nowMs() - started,
    };
    if (response.kind === 'OK' && response.embedding.length === EMBEDDING_DIMENSIONS) {
      await this.deps.economics.record({ ...usage, outcome: 'OK' });
      return {
        ok: true,
        embedding: response.embedding,
        served: { family: spec.family, tier: spec.tier, model: spec.model, provider: adapter.provider },
        costUsd: metered,
      };
    }
    const outcome: FailureOutcome =
      response.kind === 'TIMEOUT' ? 'DEADLINE' : response.kind === 'OK' ? 'SCHEMA_INVALID' : 'ERROR';
    await this.deps.economics.record({ ...usage, outcome });
    return {
      ok: false,
      outcome,
      detail: response.kind === 'OK' ? `embedding has ${response.embedding.length} dims` : response.detail,
    };
  }
}
