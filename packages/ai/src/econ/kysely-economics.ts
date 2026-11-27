import type { RouteId } from '@prometheus/contracts';
import type { Database } from '@prometheus/db';
import type { IdGen } from '@prometheus/kernel';
import { sql } from 'kysely';
import { CATALOG } from '../catalog.js';
import { usd6, type EconomicsPort, type UsageRecord } from './economics.js';

/**
 * EconomicsPort over Postgres. Works for both runtime roles that make model calls (`wiki_writer` and
 * `app_core` hold SELECT/INSERT/UPDATE on `econ.call_budget` and SELECT/INSERT on the ledger).
 */
export class KyselyEconomics implements EconomicsPort {
  constructor(
    private readonly db: Database,
    private readonly ids: IdGen,
  ) {}

  async reserve(callKey: string, route: RouteId, capUsd: number, amountUsd: number): Promise<boolean> {
    await this.db
      .insertInto('econ.call_budget')
      .values({ call_key: callKey, route, cap_usd: usd6(capUsd) })
      .onConflict((oc) => oc.column('call_key').doNothing())
      .execute();
    const amount = usd6(amountUsd);
    // One conditional UPDATE: the row lock makes concurrent reservations on the same key serial, and the
    // predicate refuses any reservation that would cross the cap (the CHECK constraint is the backstop).
    const reserved = await this.db
      .updateTable('econ.call_budget')
      .set({
        reserved_usd: sql`reserved_usd + ${amount}::numeric`,
        attempts_count: sql`LEAST(attempts_count + 1, 32767)`,
      })
      .where('call_key', '=', callKey)
      .where(sql<boolean>`reserved_usd + ${amount}::numeric <= cap_usd`)
      .returning('call_key')
      .executeTakeFirst();
    return reserved !== undefined;
  }

  async settle(
    callKey: string,
    reservedUsd: number,
    actualUsd: number,
  ): Promise<{ readonly overCapUsd: number }> {
    const reserved = usd6(reservedUsd);
    const actual = usd6(actualUsd);
    // One statement under the row lock: compute the unclamped total, store min(total, cap), return the excess.
    const { rows } = await sql<{ over_cap: string }>`
      WITH prev AS (
        SELECT call_key, reserved_usd, cap_usd FROM econ.call_budget WHERE call_key = ${callKey} FOR UPDATE
      )
      UPDATE econ.call_budget b
         SET reserved_usd = LEAST(prev.cap_usd, GREATEST(0, prev.reserved_usd - ${reserved}::numeric + ${actual}::numeric))
        FROM prev
       WHERE b.call_key = prev.call_key
   RETURNING GREATEST(0, prev.reserved_usd - ${reserved}::numeric + ${actual}::numeric - prev.cap_usd) AS over_cap`.execute(
      this.db,
    );
    return { overCapUsd: Number(rows[0]?.over_cap ?? 0) };
  }

  async record(u: UsageRecord): Promise<void> {
    await this.db
      .insertInto('econ.ai_usage_ledger')
      .values({
        id: this.ids.next(),
        idempotency_key: u.idempotencyKey,
        call_key: u.callKey,
        subsystem: u.subsystem,
        route: u.route,
        provider: u.provider,
        family: u.family,
        model_or_sku: u.modelOrSku,
        prompt_id: u.promptId,
        prompt_version: u.promptVersion,
        prompt_hash: u.promptHash,
        input_tokens: u.inputTokens,
        output_tokens: u.outputTokens,
        estimated_cost_usd: usd6(u.estimatedCostUsd),
        latency_ms: Math.max(0, Math.round(u.latencyMs)),
        outcome: u.outcome,
      })
      .onConflict((oc) => oc.column('idempotency_key').doNothing())
      .execute();
  }

  /**
   * Mirrors the catalog prices into `econ.rate_card` (wiki_writer only: app_core has SELECT on it).
   * Idempotent upsert keyed by (provider, model, unit, valid_from).
   */
  async syncRateCard(validFrom: string): Promise<number> {
    let rows = 0;
    for (const spec of Object.values(CATALOG)) {
      const units =
        spec.kind === 'EMBED'
          ? [['EMBED_1M_TOKENS', spec.inputUsdPer1M] as const]
          : ([
              ['INPUT_1M_TOKENS', spec.inputUsdPer1M],
              ['OUTPUT_1M_TOKENS', spec.outputUsdPer1M],
            ] as const);
      for (const [unit, price] of units) {
        await this.db
          .insertInto('econ.rate_card')
          .values({
            provider: spec.family,
            model_or_sku: spec.model,
            unit,
            usd_per_unit: price.toFixed(6),
            valid_from: validFrom,
          })
          .onConflict((oc) =>
            oc
              .columns(['provider', 'model_or_sku', 'unit', 'valid_from'])
              .doUpdateSet({ usd_per_unit: price.toFixed(6) }),
          )
          .execute();
        rows += 1;
      }
    }
    return rows;
  }
}
