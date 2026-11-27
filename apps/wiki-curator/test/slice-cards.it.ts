import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { loadCacheConfig, loadWikiCuratorConfig } from '@prometheus/config';
import type { Citation } from '@prometheus/contracts';
import { openRuntime, openWikiServices, type CuratorRuntime, type WikiServices } from '../src/bootstrap.js';
import { GoldenNodeInvalidError, importGolden, PendingRulingsError } from '../src/curator/golden-importer.js';
import type { GoldenNode, GoldenPlan } from '../src/curator/golden-mapping.js';
import { goodFields } from './support/curator-scenarios.js';
import { LAYERS } from '../src/curator/layers.js';
import { pathsOverlap } from '../src/curator/paths.js';

/**
 * [T2-G6] Slice Card <350-token invariant + Valkey latency, via the golden importer pipeline on a SYNTHETIC
 * two-university plan (the real golden fixtures run in the `golden` project: `pnpm test:golden`).
 */
const SEASON = '2027-FALL';
const cite = (path: string, host: string): Citation => ({
  field_path: path,
  snapshot_id: null,
  source_url: `https://www.${host}/official`,
  verbatim_quote: 'An official sentence quoted verbatim.',
  retrieved_at: '2026-11-26T16:18:00Z',
});

/** Synthetic plans state their uncovered required paths explicitly, as the real mapping module must (P1). */
function withSyntheticRulings(n: GoldenNode): GoldenNode {
  const uncited = LAYERS[n.layer].requiredPaths.filter(
    (p) => !n.citations.some((c) => pathsOverlap(c.field_path, p)),
  );
  return { ...n, rulingCovered: uncited.map((path) => ({ path, ruling: 'synthetic test fixture ruling' })) };
}

function universityPlan(uni: string, cityId: string, host: string): GoldenNode[] {
  return rawUniversityPlan(uni, cityId, host).map(withSyntheticRulings);
}

function rawUniversityPlan(uni: string, cityId: string, host: string): GoldenNode[] {
  const deep = {
    depth: 'DEEP_VERIFIED' as const,
    score: 0.97,
    slots: {},
    wikiStatus: null,
    rulingCovered: [],
  };
  const huge = Object.fromEntries(
    Array.from({ length: 300 }, (_, i) => [`fact_${i}`, `value ${i} `.repeat(8)]),
  );
  const program = goodFields();
  return [
    {
      ...deep,
      layer: 'CITY',
      nodeKey: cityId,
      citations: [cite('attributes_json.a', host)],
      fields: {
        id: cityId,
        country_iso2: 'PL',
        city_name_en: `City ${uni}`,
        monthly_living_min_eur: 600,
        monthly_living_max_eur: 900,
        minor_consents_json: [
          { code: 'NFZ_PARENT_CONSENT', authority: 'NFZ', description: 'parent consent', form_url: null },
        ],
        attributes_json: huge,
      },
    },
    {
      ...deep,
      layer: 'UNIVERSITY',
      nodeKey: uni,
      citations: [cite('general_rules_json.a', host)],
      fields: {
        id: uni,
        name_en: `University ${uni}`,
        name_local: null,
        country_iso2: 'PL',
        city_id: cityId,
        institution_type: 'PUBLIC',
        official_domain: host,
        official_email_domains_json: [host],
        primary_portal_type: 'IRK',
        portal_url: null,
        sends_email_notifications: true,
        credit_card_accepted: false,
        pricing_tier_code: 'T2',
        minor_consents_json: [],
        general_rules_json: huge,
      },
    },
    {
      ...deep,
      layer: 'HOUSING',
      nodeKey: `${uni}:2026-2027`,
      citations: [cite('critical_rules_json.a', host)],
      fields: {
        university_id: uni,
        rates_season: '2026-2027',
        portal_url: null,
        official_info_url: `https://www.${host}/dorms`,
        rate_pdf_url: null,
        total_places: 10,
        subsidized_places: null,
        monthly_min_eur: null,
        monthly_max_eur: null,
        non_refundable_on_visa_denial: true,
        critical_rules_json: huge,
        halls_json: [{ name: 'Hall', beds: 10 }],
      },
    },
    {
      ...deep,
      layer: 'PROGRAM_SPEC',
      nodeKey: `${uni}:bsc-cs:${SEASON}`,
      wikiStatus: 'ACTIVE',
      citations: [cite('tuition_annual_eur', host)],
      fields: {
        ...program,
        program_id: `${uni}:bsc-cs`,
        program_requirements_json: huge,
        program: {
          ...(program['program'] as Record<string, unknown>),
          id: `${uni}:bsc-cs`,
          university_id: uni,
        },
      },
    },
  ];
}

describe('[T2-G6] Slice Cards: 8 cards <= 350 tokens in PG and Valkey (< 5 ms reads)', () => {
  let runtime: CuratorRuntime;
  let services: WikiServices;
  const plan: GoldenPlan = {
    file: 'synthetic-cards.json',
    compiledKey: `${SEASON}:synthetic`,
    season: SEASON,
    nodes: [
      ...universityPlan('cardsa', 'PL-CARDSA', 'pw.edu.pl'),
      ...universityPlan('cardsb', 'PL-CARDSB', 'uw.edu.pl'),
    ],
    pending: [],
  };

  beforeAll(async () => {
    runtime = await openRuntime(loadWikiCuratorConfig(process.env));
    services = openWikiServices(runtime, loadCacheConfig(process.env));
  });
  afterAll(async () => {
    await services?.close();
    await runtime?.close();
  });

  it('import compiles docs / tuition_aid / city / dorms for both universities, each <= 350 tokens', async () => {
    const result = await importGolden({ ...services, clock: runtime.clock }, plan);
    expect(result.nodes.every((n) => n.status === 'WRITTEN')).toBe(true);
    const kinds = result.cards.map((c) => `${c.kind}:${c.node_id}`).sort();
    expect(kinds).toEqual([
      'city:PL-CARDSA',
      'city:PL-CARDSB',
      'docs:cardsa:bsc-cs',
      'docs:cardsb:bsc-cs',
      'dorms:cardsa',
      'dorms:cardsb',
      'tuition_aid:cardsa',
      'tuition_aid:cardsb',
    ]);
    for (const card of result.cards) {
      expect(card.text.length).toBeLessThanOrEqual(1_400);
      expect(Math.ceil(card.text.length / 4)).toBe(card.est_tokens);
      expect(card.est_tokens).toBeLessThanOrEqual(350);
      expect(card.text).toMatch(/\nSources: [a-z0-9.-]+/);
    }
    const pg = await runtime.db
      .selectFrom('wiki.program_season_spec')
      .select('agent_slice_card_json')
      .where('program_id', 'in', ['cardsa:bsc-cs', 'cardsb:bsc-cs'])
      .execute();
    expect(pg.every((r) => r.agent_slice_card_json !== null)).toBe(true);
  });

  it('Valkey returns every card in < 5 ms (median and max over 20 reads each)', async () => {
    const cards = (await importGolden({ ...services, clock: runtime.clock }, plan)).cards;
    const samples: number[] = [];
    for (const card of cards) {
      for (let i = 0; i < 20; i += 1) {
        const t = performance.now();
        const got = await services.cards.get({ kind: card.kind, nodeId: card.node_id, season: card.season });
        samples.push(performance.now() - t);
        expect(got).toEqual(card);
      }
    }
    samples.sort((a, b) => a - b);
    const median = samples[Math.floor(samples.length / 2)] ?? Infinity;
    const p99 = samples[Math.floor(samples.length * 0.99)] ?? Infinity;
    console.log(
      `[T2-G6] Valkey card read: median ${median.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms, max ${(samples.at(-1) ?? 0).toFixed(3)} ms (n=${samples.length})`,
    );
    expect(median).toBeLessThan(5);
    expect(p99).toBeLessThan(5);
  });

  it('re-import is idempotent: unchanged nodes are not rewritten (no version bump, no new revision)', async () => {
    const before = await sql<{
      n: string;
    }>`SELECT count(*) AS n FROM wiki.node_revision WHERE node_key LIKE 'cards%' OR node_key LIKE 'PL-CARDS%'`.execute(
      runtime.db,
    );
    const result = await importGolden({ ...services, clock: runtime.clock }, plan);
    expect(result.nodes.every((n) => n.status === 'UNCHANGED' && n.version === 1)).toBe(true);
    const after = await sql<{
      n: string;
    }>`SELECT count(*) AS n FROM wiki.node_revision WHERE node_key LIKE 'cards%' OR node_key LIKE 'PL-CARDS%'`.execute(
      runtime.db,
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('a plan with a TODO_RULING marker fails loudly BEFORE any write', async () => {
    const pendingPlan: GoldenPlan = {
      ...plan,
      nodes: universityPlan('cardsc', 'PL-CARDSC', 'pw.edu.pl'),
      pending: [
        {
          id: 'B5-PRICING-TIER',
          pointer: 'synthetic $.layer_3_university -> wiki.university.pricing_tier_code',
        },
      ],
    };
    await expect(importGolden({ ...services, clock: runtime.clock }, pendingPlan)).rejects.toBeInstanceOf(
      PendingRulingsError,
    );
    const rows = await runtime.db
      .selectFrom('wiki.university')
      .select('id')
      .where('id', '=', 'cardsc')
      .execute();
    expect(rows).toEqual([]);
  });

  it('a DEEP_VERIFIED node without citations is rejected by the importer (and the DB trigger would too)', async () => {
    const bad: GoldenPlan = {
      ...plan,
      nodes: universityPlan('cardsd', 'PL-CARDSD', 'pw.edu.pl').map((n) => ({ ...n, citations: [] })),
    };
    await expect(importGolden({ ...services, clock: runtime.clock }, bad)).rejects.toBeInstanceOf(
      GoldenNodeInvalidError,
    );
  });

  it('P1 golden provenance: an uncited required path without a ruling entry fails the import loudly', async () => {
    const nodes = universityPlan('cardse', 'PL-CARDSE', 'pw.edu.pl').map((n) =>
      n.layer === 'UNIVERSITY' ? { ...n, rulingCovered: n.rulingCovered.slice(1) } : n,
    );
    await expect(importGolden({ ...services, clock: runtime.clock }, { ...plan, nodes })).rejects.toThrow(
      /uncited required path\(s\) not covered by a ruling/,
    );
  });

  it('golden revisions record evidence_basis ARCHITECT_RULING + the ruling-covered paths', async () => {
    const rev = await runtime.db
      .selectFrom('wiki.node_revision')
      .select('after_json')
      .where('node_key', '=', 'cardsa')
      .executeTakeFirstOrThrow();
    expect(rev.after_json).toMatchObject({
      evidence_basis: 'ARCHITECT_RULING',
      ruling_covered_paths: expect.any(Array),
    });
  });

  it('MEDIUM-4: quarantining a university invalidates every dependent card (docs of its programmes, tuition_aid, dorms)', async () => {
    const store = services.layers;
    const uni = await store.findNode('UNIVERSITY', 'cardsa');
    if (!uni) throw new Error('cardsa missing');
    const result = await store.transaction(async (tx) => {
      await tx.quarantineNode({
        layer: 'UNIVERSITY',
        nodeKey: 'cardsa',
        expectedVersion: uni.version,
        actor: 'HUMAN',
        reason: 'it',
        evidence: {},
      });
      return services.materializer.materialize(tx, 'UNIVERSITY', 'cardsa', SEASON);
    });
    await services.cards.publish(result);
    expect(result.evict.map((e) => `${e.kind}:${e.nodeId}`).sort()).toEqual([
      'docs:cardsa:bsc-cs',
      'dorms:cardsa',
      'tuition_aid:cardsa',
    ]);
    const spec = await runtime.db
      .selectFrom('wiki.program_season_spec')
      .select('agent_slice_card_json')
      .where('program_id', '=', 'cardsa:bsc-cs')
      .executeTakeFirstOrThrow();
    expect(spec.agent_slice_card_json).toBeNull();
    const dorm = await runtime.db
      .selectFrom('wiki.university_housing')
      .select('agent_slice_card_json')
      .where('university_id', '=', 'cardsa')
      .executeTakeFirstOrThrow();
    expect(dorm.agent_slice_card_json).toBeNull();
    for (const ref of result.evict) expect(await services.cards.get(ref)).toBeUndefined();
  });

  it('MEDIUM-4: quarantining a programme recompiles its university tuition_aid card without it', async () => {
    const store = services.layers;
    const spec = await store.findNode('PROGRAM_SPEC', `cardsb:bsc-cs:${SEASON}`);
    if (!spec) throw new Error('cardsb spec missing');
    const before = await services.cards.get({ kind: 'tuition_aid', nodeId: 'cardsb', season: SEASON });
    expect(before?.text).toContain('Computer Science: EUR');
    const result = await store.transaction(async (tx) => {
      await tx.quarantineNode({
        layer: 'PROGRAM_SPEC',
        nodeKey: `cardsb:bsc-cs:${SEASON}`,
        expectedVersion: spec.version,
        actor: 'HUMAN',
        reason: 'it',
        evidence: {},
      });
      return services.materializer.materialize(tx, 'PROGRAM_SPEC', `cardsb:bsc-cs:${SEASON}`, SEASON);
    });
    await services.cards.publish(result);
    const after = await services.cards.get({ kind: 'tuition_aid', nodeId: 'cardsb', season: SEASON });
    expect(after?.text).not.toContain('Computer Science: EUR');
    expect(
      await services.cards.get({ kind: 'docs', nodeId: 'cardsb:bsc-cs', season: SEASON }),
    ).toBeUndefined();
  });
});
