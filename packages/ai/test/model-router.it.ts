import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VerificationReport } from '@prometheus/contracts';
import { connectAs, type Database } from '@prometheus/db';
import { createUuidV7Generator, systemClock } from '@prometheus/kernel';
import { itConnection } from '../../db/test/it-env.js';
import { CassetteStore, ReplayAdapter, cassetteKey, type Cassette } from '../src/adapters/replay.js';
import { KyselyEconomics } from '../src/econ/kysely-economics.js';
import { ModelRouter, cassetteMaterialFor, type GenerateCall } from '../src/router.js';

/** Small deterministic PRNG (mulberry32) so the property run is reproducible from its seed. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('[T2-G4] econ.call_budget atomic reservation on real Postgres', () => {
  let writer: Database;
  let appCore: Database;

  beforeAll(async () => {
    writer = await connectAs('wiki_writer', { ...itConnection('wiki_writer'), maxConnections: 10 });
    appCore = await connectAs('app_core', { ...itConnection('app_core'), maxConnections: 10 });
  });
  afterAll(async () => {
    await writer?.destroy();
    await appCore?.destroy();
  });

  it('property: parallel reserve/settle storms from BOTH runtime roles never exceed cap_usd', async () => {
    const SEED = 20261127;
    const rand = prng(SEED);
    const ids = createUuidV7Generator(systemClock);
    const stores = [new KyselyEconomics(writer, ids), new KyselyEconomics(appCore, ids)];
    for (let trial = 0; trial < 12; trial += 1) {
      const callKey = `prop:${SEED}:${trial}:${randomUUID()}`;
      const cap = Math.round((0.01 + rand() * 0.49) * 1e6) / 1e6;
      const attempts = Array.from({ length: 40 }, () => ({
        amount: Math.round(rand() * cap * 0.4 * 1e6) / 1e6 + 0.000001,
        actualRatio: rand(),
        store: stores[Math.floor(rand() * 2)] ?? stores[0],
      }));
      const accepted: number[] = [];
      await Promise.all(
        attempts.map(async (a) => {
          if (!a.store) throw new Error('no store');
          if (await a.store.reserve(callKey, 'RTE-wiki.deep_extract', cap, a.amount)) {
            accepted.push(a.amount);
            await a.store.settle(callKey, a.amount, a.amount * a.actualRatio);
          }
        }),
      );
      const row = await writer
        .selectFrom('econ.call_budget')
        .select(['cap_usd', 'reserved_usd', 'attempts_count'])
        .where('call_key', '=', callKey)
        .executeTakeFirstOrThrow();
      expect(Number(row.reserved_usd), `trial ${trial}`).toBeLessThanOrEqual(Number(row.cap_usd));
      expect(Number(row.cap_usd)).toBeCloseTo(cap, 6);
      expect(row.attempts_count).toBe(accepted.length);
      expect(accepted.length).toBeGreaterThan(0);
    }
  });

  it('without settlement, accepted reservations sum to at most the cap (pure race on one key)', async () => {
    const econ = new KyselyEconomics(writer, createUuidV7Generator(systemClock));
    const callKey = `race:${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 60 }, () => econ.reserve(callKey, 'RTE-wiki.deep_verify', 0.5, 0.03)),
    );
    const accepted = results.filter(Boolean).length;
    expect(accepted).toBe(16); // floor(0.5 / 0.03)
    const row = await writer
      .selectFrom('econ.call_budget')
      .select('reserved_usd')
      .where('call_key', '=', callKey)
      .executeTakeFirstOrThrow();
    expect(Number(row.reserved_usd)).toBeCloseTo(0.48, 6);
  });

  it('MEDIUM-1: settling above the cap returns the excess (overCapUsd) instead of absorbing it silently', async () => {
    const econ = new KyselyEconomics(writer, createUuidV7Generator(systemClock));
    const callKey = `overspend:${randomUUID()}`;
    expect(await econ.reserve(callKey, 'RTE-wiki.deep_extract', 0.5, 0.4)).toBe(true);
    expect(await econ.settle(callKey, 0.4, 0.7)).toEqual({ overCapUsd: 0.2 });
    const row = await writer
      .selectFrom('econ.call_budget')
      .select(['reserved_usd', 'cap_usd'])
      .where('call_key', '=', callKey)
      .executeTakeFirstOrThrow();
    expect(Number(row.reserved_usd)).toBeCloseTo(0.5, 6); // the budget row stays within its CHECK ...
    expect(await econ.reserve(callKey, 'RTE-wiki.deep_extract', 0.5, 0.000001)).toBe(false); // ... and is exhausted
    expect(await econ.settle(callKey, 0, 0)).toEqual({ overCapUsd: 0 });
  });

  it('the CHECK constraint is the backstop: a direct over-cap write fails 23514', async () => {
    const callKey = `check:${randomUUID()}`;
    await writer
      .insertInto('econ.call_budget')
      .values({ call_key: callKey, route: 'x', cap_usd: '0.010000' })
      .execute();
    await expect(
      writer
        .updateTable('econ.call_budget')
        .set({ reserved_usd: '0.020000' })
        .where('call_key', '=', callKey)
        .execute(),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('router + replay + Postgres ledger: parallel deep_verify calls on one call key never settle above the cap', async () => {
    const report = { verification_score: 0.99, checked_paths: ['a'], discrepancies: [] };
    const call = (i: number): GenerateCall<VerificationReport> => ({
      route: 'RTE-wiki.deep_verify',
      dataClass: 'OFFICIAL_SOURCE_ONLY',
      idempotencyKey: `router-race:${i}:${randomUUID()}`,
      callKey: sharedKey,
      excludeFamily: 'google-gemini',
      vars: {
        layer: 'PROGRAM_SPEC',
        node_key: 'n',
        season: '2027-FALL',
        required_paths: ['a'],
      },
      untrusted: [{ kind: 'web', url: 'https://www.pw.edu.pl/', text: 'x'.repeat(60_000) }],
      schema: VerificationReport,
      schemaName: 'verification_report',
    });
    const sharedKey = `verify:PROGRAM_SPEC:race:${randomUUID()}`;
    const material = cassetteMaterialFor(call(0), 'oa.flagship');
    const cassette: Cassette = {
      key: cassetteKey(material),
      material,
      note: 'model-router.it race',
      // metered usage close to the worst case, so the cap binds
      response: { kind: 'GENERATE', text: JSON.stringify(report), inputTokens: 21_000, outputTokens: 6_000 },
    };
    const replay = new ReplayAdapter(new CassetteStore([cassette]));
    const econ = new KyselyEconomics(writer, createUuidV7Generator(systemClock));
    const router = new ModelRouter({
      adapters: { 'openai-gpt': replay, 'google-gemini': replay },
      economics: econ,
    });

    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => router.generate(call(i))));
    const ok = results.filter((r) => r.ok);
    const budget = results.filter((r) => !r.ok && r.outcome === 'BUDGET');
    expect(ok.length + budget.length).toBe(12);
    expect(ok.length).toBeGreaterThan(0);
    expect(budget.length).toBeGreaterThan(0);
    for (const r of ok) expect(r.ok && r.served.family).toBe('openai-gpt');

    const row = await writer
      .selectFrom('econ.call_budget')
      .select(['cap_usd', 'reserved_usd'])
      .where('call_key', '=', sharedKey)
      .executeTakeFirstOrThrow();
    expect(Number(row.reserved_usd)).toBeLessThanOrEqual(Number(row.cap_usd));
    const ledger = await writer
      .selectFrom('econ.ai_usage_ledger')
      .selectAll()
      .where('call_key', '=', sharedKey)
      .execute();
    const okRows = ledger.filter((l) => l.outcome === 'OK');
    expect(okRows).toHaveLength(ok.length);
    const settled = okRows.reduce((s, l) => s + Number(l.estimated_cost_usd), 0);
    // MEDIUM-1: this is the TRUE spend (no clamp anywhere on the ledger side), so the assertion can fail
    expect(settled).toBeLessThanOrEqual(0.5);
    expect(results.every((r) => r.overCapUsd === 0)).toBe(true);
    expect(new Set(ledger.map((l) => l.family))).toEqual(new Set(['replay']));
    // deep_verify's primary is openai; the excluded gemini fallback is never used (GR-AI-009)
    expect(ledger.every((l) => l.model_or_sku.startsWith('replay:'))).toBe(true);
  });

  it('ledger writes are idempotent per attempt key (a replayed workflow step never double-counts)', async () => {
    const econ = new KyselyEconomics(writer, createUuidV7Generator(systemClock));
    const key = `idem:${randomUUID()}`;
    const usage = {
      idempotencyKey: key,
      callKey: null,
      subsystem: 'WIKI_BASELINE' as const,
      route: 'RTE-wiki.link_healer' as const,
      provider: 'replay',
      family: 'replay' as const,
      modelOrSku: 'replay:x',
      promptId: 'p',
      promptVersion: '1',
      promptHash: 'a'.repeat(64),
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: 0.000001,
      latencyMs: 1,
      outcome: 'OK' as const,
    };
    await econ.record(usage);
    await econ.record(usage);
    const rows = await writer
      .selectFrom('econ.ai_usage_ledger')
      .select('id')
      .where('idempotency_key', '=', key)
      .execute();
    expect(rows).toHaveLength(1);
  });
});
