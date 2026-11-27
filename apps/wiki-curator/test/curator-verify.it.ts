import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCacheConfig, loadWikiCuratorConfig } from '@prometheus/config';
import {
  openDurableCurator,
  openModelRouter,
  openRuntime,
  openWikiServices,
  type CuratorRuntime,
  type DurableCurator,
  type WikiServices,
} from '../src/bootstrap.js';
import { DomainAllowlist } from '../src/crawler/allowlist.js';
import { DualPassCurator } from '../src/curator/pipeline.js';
import { KyselySnapshotReader } from '../src/persistence/kysely-wiki-layer-repository.js';
import { cardCacheKey } from '../src/curator/slice-cards.js';
import { verifyWorkflowId } from '../src/curator/workflows.js';
import {
  CASSETTE_DIR,
  CITY_ID,
  SCENARIOS,
  SEASON,
  UNIVERSITY_ID,
  gatheredOf,
  targetOf,
  type Scenario,
} from './support/curator-scenarios.js';
import { seedScenarioContext, seedScenarioSnapshot } from './support/scenario-seed.js';

/**
 * [T2-G5] Dual-pass curator on DBOS (WF-03) with replay cassettes, real Postgres (wiki_writer), MinIO and
 * Valkey. Agent A is served by google-gemini (deep_extract primary), so Agent B MUST be openai-gpt.
 */
describe('[T2-G5] WF-03 WikiDeepVerify: publish gate + seeded-error quarantine', () => {
  let runtime: CuratorRuntime;
  let services: WikiServices;
  let durable: DurableCurator;
  const valkey = loadCacheConfig(process.env);

  beforeAll(async () => {
    runtime = await openRuntime(loadWikiCuratorConfig(process.env));
    services = openWikiServices(runtime, valkey);
    await seedScenarioContext(runtime, services);
    for (const s of Object.values(SCENARIOS)) await seedScenarioSnapshot(runtime, s);
    const base = {
      score: null,
      citations: [],
      slotCompleteness: {},
      lockedPaths: [],
      expectedVersion: 0,
      actor: 'HUMAN' as const,
      reason: 'curator-verify.it context',
      verifiedAt: new Date(),
    };
    const locked = SCENARIOS.locked;
    if (locked.existing === undefined) throw new Error('locked scenario needs an existing node');
    await services.layers.writeNode({
      ...base,
      layer: 'PROGRAM_SPEC',
      nodeKey: locked.targetKey,
      fields: locked.existing.fields,
      depth: 'BASELINE',
      wikiStatus: 'ACTIVE',
      lockedPaths: locked.existing.lockedPaths,
    });
    const router = await openModelRouter(runtime, { mode: 'replay', cassetteDir: CASSETTE_DIR });
    durable = await openDurableCurator(runtime, services, router);
  });

  afterAll(async () => {
    await durable?.close();
    await services?.close();
    await runtime?.close();
  });

  const spec = (programId: string) =>
    runtime.db
      .selectFrom('wiki.program_season_spec')
      .selectAll()
      .where('program_id', '=', programId)
      .where('admission_season', '=', SEASON)
      .executeTakeFirstOrThrow();

  const ledger = (s: Scenario, version: number) =>
    runtime.db
      .selectFrom('econ.ai_usage_ledger')
      .selectAll()
      .where('call_key', '=', `verify:PROGRAM_SPEC:${s.targetKey}:${verifyWorkflowId(targetOf(s), version)}`)
      .orderBy('created_at')
      .execute();

  it('step 1 gathers exactly the stored snapshot text the cassettes were synthesised from', async () => {
    const allowlist = new DomainAllowlist(await runtime.repo.loadAllowlist());
    const curator = new DualPassCurator({
      router: await openModelRouter(runtime, { mode: 'replay', cassetteDir: CASSETTE_DIR }),
      layers: services.layers,
      snapshots: new KyselySnapshotReader(runtime.db, runtime.blobs),
      isAllowlisted: (u) => allowlist.allows(u),
      materializer: services.materializer,
      clock: runtime.clock,
      useModelLinkHealer: false,
    });
    for (const s of Object.values(SCENARIOS))
      expect(await curator.gather(s.targetKey, 'it')).toEqual(gatheredOf(s));
  });

  it('valid snapshot + valid Agent A + passing cross-family Agent B -> DEEP_VERIFIED + revision + 4 Slice Cards in PG and Valkey', async () => {
    const s = SCENARIOS.good;
    // two concurrent requests for the same node version join ONE single-flight execution
    const [result, joined] = await Promise.all([
      durable.workflows.verify(targetOf(s), 0),
      durable.workflows.verify(targetOf(s), 0),
    ]);
    expect(joined).toEqual(result);
    expect(result).toMatchObject({
      status: 'DEEP_VERIFIED',
      version: 1,
      rounds: 1,
      agentA: { family: 'google-gemini', tier: 'gg.pro' },
      agentB: { family: 'openai-gpt', tier: 'oa.flagship' },
      agentBCalls: 1,
      validatorErrors: [],
    });
    const row = await spec(s.programId);
    expect(row).toMatchObject({
      verification_depth: 'DEEP_VERIFIED',
      wiki_status: 'ACTIVE',
      version: 1,
      tuition_annual_eur: 6000,
    });
    expect(Number(row.verification_score)).toBeCloseTo(0.97, 3);
    expect(row.citations_json).toHaveLength(4);
    const revisions = await runtime.db
      .selectFrom('wiki.node_revision')
      .selectAll()
      .where('node_key', '=', s.targetKey)
      .execute();
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ layer: 'PROGRAM_SPEC', version: 1, actor: 'AI_CURATOR' });

    expect(result.cards.map((c) => c.kind).sort()).toEqual(['city', 'docs', 'dorms', 'tuition_aid']);
    expect(row.agent_slice_card_json).not.toBeNull();
    const uni = await runtime.db
      .selectFrom('wiki.university')
      .select('agent_slice_card_json')
      .where('id', '=', UNIVERSITY_ID)
      .executeTakeFirstOrThrow();
    const city = await runtime.db
      .selectFrom('wiki.city_profile')
      .select('agent_slice_card_json')
      .where('id', '=', CITY_ID)
      .executeTakeFirstOrThrow();
    const dorm = await runtime.db
      .selectFrom('wiki.university_housing')
      .select('agent_slice_card_json')
      .where('university_id', '=', UNIVERSITY_ID)
      .executeTakeFirstOrThrow();
    for (const v of [uni, city, dorm]) expect(v.agent_slice_card_json).not.toBeNull();
    for (const card of result.cards) {
      expect(card.est_tokens).toBeLessThanOrEqual(350);
      const cached = await services.cards.get({ kind: card.kind, nodeId: card.node_id, season: card.season });
      expect(cached, cardCacheKey(card)).toEqual(card);
    }

    const rows = await ledger(s, 0);
    expect(rows.map((r) => `${r.route}:${r.outcome}`)).toEqual([
      'RTE-wiki.deep_extract:OK',
      'RTE-wiki.deep_verify:OK',
    ]);
    expect(rows.every((r) => r.family === 'replay')).toBe(true);
    const search = await runtime.db
      .selectFrom('wiki.program_embedding')
      .selectAll()
      .where('program_id', '=', s.programId)
      .executeTakeFirstOrThrow();
    expect(search.search_text).toContain('Computer Science');
    expect(search.embedding).toBeNull(); // pg_trgm fallback (no embed step configured)
  });

  it('seeded error #1 (hallucinated quote): deterministic validator rejects both rounds, 0 Agent B calls -> QUARANTINED', async () => {
    const s = SCENARIOS.halluc;
    const result = await durable.workflows.verify(targetOf(s), 0);
    expect(result).toMatchObject({ status: 'QUARANTINED', rounds: 2, agentBCalls: 0, agentB: null });
    expect(result.validatorErrors.map((e) => e.code)).toContain('QUOTE_NOT_FOUND');
    const row = await spec(s.programId);
    expect(row).toMatchObject({
      verification_depth: 'QUARANTINED',
      wiki_status: 'DRAFT',
      agent_slice_card_json: null,
    });
    const rows = await ledger(s, 0);
    expect(rows.map((r) => r.route)).toEqual(['RTE-wiki.deep_extract', 'RTE-wiki.deep_extract']);
  });

  it('seeded error #2 (Agent B flags EU_VS_NONEU deadline, score 0.70) -> QUARANTINED, never ACTIVE', async () => {
    const s = SCENARIOS.euvsnoneu;
    const result = await durable.workflows.verify(targetOf(s), 0);
    expect(result).toMatchObject({ status: 'QUARANTINED', rounds: 2, agentBCalls: 2 });
    expect(result.gate?.failures).toEqual(expect.arrayContaining(['DISCREPANCIES', 'SCORE_BELOW_THRESHOLD']));
    const row = await spec(s.programId);
    expect(row).toMatchObject({ verification_depth: 'QUARANTINED', wiki_status: 'DRAFT' });
    expect(Number(row.verification_score)).toBeCloseTo(0.7, 3);
  });

  it('seeded error #3 (LOCKED_BY_HUMAN tuition): pinned 4000 survives Agent A 9999, lockConflicts returned', async () => {
    const s = SCENARIOS.locked;
    const result = await durable.workflows.verify(targetOf(s), 1);
    expect(result).toMatchObject({ status: 'DEEP_VERIFIED', version: 2 });
    expect(result.lockConflicts).toEqual([{ path: 'tuition_annual_eur', pinned: 4000, proposed: 9999 }]);
    const row = await spec(s.programId);
    expect(row).toMatchObject({ tuition_annual_eur: 4000, verification_depth: 'DEEP_VERIFIED', version: 2 });
    expect(row.locked_fields_json).toEqual(['tuition_annual_eur']);
  });

  it('a stale version starts no work (single-flight is per node version)', async () => {
    const result = await durable.workflows.verify(targetOf(SCENARIOS.locked), 0);
    expect(result).toMatchObject({ status: 'ABORTED', abortReason: expect.stringContaining('version 2') });
  });
});
