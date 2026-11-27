import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { loadAiConfig, loadCacheConfig, loadCoreConfig, loadWikiCuratorConfig } from '@prometheus/config';
import type { SliceCard } from '@prometheus/contracts';
import {
  openRuntime,
  openWikiServices,
  type CuratorRuntime,
  type WikiServices,
} from '../../../apps/wiki-curator/src/bootstrap.js';
import { importGolden, readGoldenPlan } from '../../../apps/wiki-curator/src/curator/golden-importer.js';
import { openCoreRuntime, type CoreRuntime } from '../../../apps/core/src/bootstrap.js';
import { evaluateL1, KyselyMatchCatalog } from '../../../apps/core/src/modules/matching/index.js';
import { GOLDEN_FILES, gate7Violations, goldenPath, loadGate7Profiles } from './support/golden.js';

/**
 * [T2-G6][T2-G7] Golden records end to end on real Postgres + Valkey: import both fixtures as wiki_writer
 * (curator), then match as app_core (core). Written to the final ENG-T2 §6 spec; it can only pass once every
 * golden-mapping TODO_RULING is ruled (currently B5: wiki.university.pricing_tier_code).
 */
describe('[T2-G6][T2-G7] golden import -> 8 Slice Cards -> $0 matching (Profiles 1-3)', () => {
  let curator: CuratorRuntime;
  let services: WikiServices;
  let core: CoreRuntime;
  const cards: SliceCard[] = [];

  beforeAll(async () => {
    curator = await openRuntime(loadWikiCuratorConfig(process.env));
    services = openWikiServices(curator, loadCacheConfig(process.env));
    for (const file of GOLDEN_FILES) {
      const plan = await readGoldenPlan(goldenPath(file));
      cards.push(...(await importGolden({ ...services, clock: curator.clock }, plan)).cards);
    }
    core = await openCoreRuntime(loadCoreConfig(process.env), loadAiConfig(process.env));
  });

  afterAll(async () => {
    await core?.close();
    await services?.close();
    await curator?.close();
  });

  it('P1 golden provenance: every golden revision records evidence_basis GOLDEN_FIXTURE', async () => {
    const revs = await curator.db
      .selectFrom('wiki.node_revision')
      .select(['node_key', 'after_json'])
      .where('actor', '=', 'GOLDEN_FIXTURE')
      .execute();
    expect(revs.length).toBeGreaterThanOrEqual(18);
    for (const r of revs)
      expect(r.after_json, r.node_key).toMatchObject({ evidence_basis: 'GOLDEN_FIXTURE' });
  });

  it('Gate 6: all 8 primary cards (docs, tuition_aid, city, dorms x 2) exist, <= 350 tokens, in PG and Valkey < 5 ms', async () => {
    const wanted = [
      'docs:polimi:msc-cse',
      'tuition_aid:polimi',
      'city:IT-MILAN',
      'dorms:polimi',
      'docs:wut:bsc-cs-networks',
      'tuition_aid:wut',
      'city:PL-WARSAW',
      'dorms:wut',
    ];
    const keys = new Set(cards.map((c) => `${c.kind}:${c.node_id}`));
    for (const w of wanted) expect(keys.has(w), w).toBe(true);
    for (const c of cards) expect(c.est_tokens).toBeLessThanOrEqual(350);
    // LOW-7: p95 over 20 reads per card (a single sample is flaky on a loaded runner)
    const samples: number[] = [];
    for (const c of cards.filter((x) => wanted.includes(`${x.kind}:${x.node_id}`))) {
      for (let i = 0; i < 20; i += 1) {
        const t = performance.now();
        const got = await services.cards.get({ kind: c.kind, nodeId: c.node_id, season: c.season });
        samples.push(performance.now() - t);
        expect(got).toEqual(c);
      }
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? Infinity;
    console.log(`[T2-G6] golden Valkey card reads: p95 ${p95.toFixed(3)} ms (n=${samples.length})`);
    expect(p95).toBeLessThan(5);
  });

  for (const p of loadGate7Profiles()) {
    it(`Gate 7 ${p.id} as app_core with 0 ledger rows: ${p.label}`, async () => {
      const before = Number(
        (await sql<{ n: string }>`SELECT count(*) AS n FROM econ.ai_usage_ledger`.execute(core.db)).rows[0]
          ?.n,
      );
      const result = await core.matching.match(p.input, { asOf: new Date(p.asOf) });
      expect(gate7Violations(p.id, result)).toEqual([]);
      expect(result.llmCostUsd).toBe(0);
      const after = Number(
        (await sql<{ n: string }>`SELECT count(*) AS n FROM econ.ai_usage_ledger`.execute(core.db)).rows[0]
          ?.n,
      );
      expect(after).toBe(before);
    });
  }

  it('Gate 7 benchmark: L1 over 250 cloned active golden specs < 20 ms, $0', async () => {
    const catalog = await new KyselyMatchCatalog(core.db).load('2027-FALL', []);
    const clones = Array.from({ length: 250 }, (_, i) => {
      const c = catalog.candidates[i % catalog.candidates.length];
      if (c === undefined) throw new Error('empty golden catalog');
      return { ...c, program: { ...c.program, id: `${c.program.id}-clone${i}` } };
    });
    const profile = loadGate7Profiles()[1];
    if (profile === undefined) throw new Error('no P2');
    const cloned = { candidates: clones, originRules: catalog.originRules };
    evaluateL1(profile.input, cloned, new Date(profile.asOf));
    const t = performance.now();
    const r = evaluateL1(profile.input, cloned, new Date(profile.asOf));
    const ms = performance.now() - t;
    console.log(`[T2-G7] golden L1 250 clones: ${ms.toFixed(3)} ms`);
    expect(r.matches.length + r.excluded.length).toBe(250);
    expect(ms).toBeLessThan(20);
  });
});
