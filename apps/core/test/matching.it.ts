import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { loadAiConfig, loadCoreConfig } from '@prometheus/config';
import type { ApplicantMatchInput, MatchResult } from '@prometheus/contracts';
import { connectAs, PG_INSUFFICIENT_PRIVILEGE, pgErrorCode, type Database } from '@prometheus/db';
import { itConnection } from '../../../packages/db/test/it-env.js';
import { openCoreRuntime, type CoreRuntime } from '../src/bootstrap.js';
import { buildApp } from '../src/http/app.js';

/**
 * [T2-G1][T2-G7] apps/core matching on real Postgres: the composed runtime connects ONLY as app_core,
 * reads wiki.* SELECT-only, applies the matchable filter (ACTIVE + BASELINE|DEEP_VERIFIED) in SQL and in L1,
 * scores L2 with pg_trgm, and writes ZERO econ.ai_usage_ledger rows ($0) for structured profiles.
 */
describe('[T2-G7] $0 matching as app_core (SQL catalog + L2 pg_trgm + HTTP dev endpoint)', () => {
  let writer: Database;
  let core: CoreRuntime;
  const tag = randomUUID().slice(0, 6);
  const uni = `mit${tag}`;
  const city = `PL-MIT${tag.toUpperCase()}`;
  const season = '2027-FALL';
  const ids = {
    active: `${uni}:bsc-cs`,
    baseline: `${uni}:bsc-power`,
    quarantined: `${uni}:bsc-q`,
    draft: `${uni}:bsc-d`,
  };

  const spec = (programId: string, overrides: Record<string, unknown>) => ({
    id: randomUUID(),
    program_id: programId,
    admission_season: season,
    wiki_status: 'ACTIVE',
    verification_depth: 'BASELINE',
    tuition_annual_eur: 4680,
    accepted_prior_fields_json: JSON.stringify({ exact: ['STEM_QRUP_1'], adjacent: [] }),
    predicted_grades_accepted: false,
    min_english_requirements_json: JSON.stringify({
      min_cefr: 'B2',
      accepted_tests: [{ exam: 'IELTS_ACADEMIC', min_score: 6, valid_from: null, valid_until: null }],
      rejected_tests: [],
      other_accepted: [],
    }),
    app_window_close_at: '2027-07-15T21:59:00Z',
    qualified_docs_deadline_at: '2027-08-15T21:59:00Z',
    classes_start_date: '2027-10-01',
    program_requirements_json: '{}',
    ...overrides,
  });

  const profile: ApplicantMatchInput = {
    dob: '2010-02-15',
    citizenshipCountry: 'AZ',
    residenceCountry: 'AZ',
    diplomaCountry: 'AZ',
    diplomaType: 'CIS_11YR_ATTESTAT',
    yearsOfSchooling: 11,
    diplomaStatus: 'IN_PROGRESS',
    expectedDiplomaMonth: '2027-06',
    priorInstructionLanguage: 'ru',
    priorEmiPct: 0,
    priorFieldCode: 'STEM_QRUP_1',
    gpaNormalized100: 88,
    mathGrade100: 95,
    targetDegree: 'BACHELOR',
    targetSeason: season,
    targetFields: ['computer science'],
    preferredCountries: ['PL'],
    instructionLanguages: ['en'],
    annualBudgetEur: 12_000,
    openToScholarships: false,
    householdIncomeUnder25kEur: 'UNKNOWN',
    exams: [{ type: 'IELTS_ACADEMIC', status: 'OBTAINED', score: 6.5 }],
  };

  beforeAll(async () => {
    writer = await connectAs('wiki_writer', itConnection('wiki_writer'));
    await writer
      .insertInto('wiki.city_profile')
      .values({
        id: city,
        country_iso2: 'PL',
        city_name_en: 'M',
        attributes_json: '{}',
        verification_depth: 'BASELINE',
      })
      .execute();
    await writer
      .insertInto('wiki.university')
      .values({
        id: uni,
        name_en: 'Matching IT Uni',
        country_iso2: 'PL',
        city_id: city,
        institution_type: 'PUBLIC',
        official_domain: 'pw.edu.pl',
        primary_portal_type: 'IRK',
        pricing_tier_code: 'T1',
        credit_card_accepted: false,
        general_rules_json: '{}',
        verification_depth: 'BASELINE',
      })
      .execute();
    for (const [key, id] of Object.entries(ids)) {
      await writer
        .insertInto('wiki.program')
        .values({
          id,
          university_id: uni,
          name_en: key === 'active' ? 'Computer Science' : 'Power Engineering',
          degree_level: 'BACHELOR',
          field_code: 'X',
          instruction_language: 'en',
          duration_semesters: 7,
          official_program_url: 'https://www.pw.edu.pl/',
        })
        .execute();
      await writer
        .insertInto('wiki.program_embedding')
        .values({
          program_id: id,
          model_id: 'none:pg_trgm',
          search_text:
            key === 'active' ? 'Computer Science | CS_IT | Algorithms' : 'Power Engineering | POWER_ENG',
        })
        .execute();
    }
    await writer
      .insertInto('wiki.program_season_spec')
      .values(spec(ids.active, { tuition_annual_eur: 11_040 }))
      .execute();
    await writer.insertInto('wiki.program_season_spec').values(spec(ids.baseline, {})).execute();
    await writer
      .insertInto('wiki.program_season_spec')
      .values(spec(ids.quarantined, { verification_depth: 'QUARANTINED', wiki_status: 'DRAFT' }))
      .execute();
    await writer
      .insertInto('wiki.program_season_spec')
      .values(spec(ids.draft, { wiki_status: 'DRAFT' }))
      .execute();
    await writer
      .insertInto('wiki.origin_equivalency_rule')
      .values({
        id: randomUUID(),
        destination_country_iso2: 'PL',
        citizenship_country: 'AZ',
        diploma_origin_country: 'AZ',
        diploma_type: 'CIS_11YR_ATTESTAT',
        admission_season: season,
        equivalency_policy: 'DIRECT_WITH_NATIONAL_STATEMENT',
        national_recognition_lead_days: 60,
        ru_sector_translation_exempt: true,
        legalization_rules_json: '{}',
        verification_depth: 'BASELINE',
      })
      .execute();
    core = await openCoreRuntime(loadCoreConfig(process.env), loadAiConfig(process.env));
  });

  afterAll(async () => {
    await core?.close();
    await writer?.destroy();
  });

  const ledgerCount = async () =>
    Number(
      (await sql<{ n: string }>`SELECT count(*) AS n FROM econ.ai_usage_ledger`.execute(writer)).rows[0]?.n ??
        0,
    );

  it('the composed core runtime is authenticated as app_core and cannot write wiki.*', async () => {
    const { rows } = await sql<{ u: string }>`SELECT current_user AS u`.execute(core.db);
    expect(rows[0]?.u).toBe('app_core');
    try {
      await core.db
        .updateTable('wiki.program_season_spec')
        .set({ tuition_annual_eur: 1 })
        .where('program_id', '=', ids.active)
        .execute();
      expect.unreachable('app_core wrote wiki.program_season_spec');
    } catch (error) {
      expect(pgErrorCode(error)).toBe(PG_INSUFFICIENT_PRIVILEGE);
    }
  });

  it('matches only ACTIVE BASELINE/DEEP_VERIFIED specs, with L2 pg_trgm scores and 0 ledger rows ($0)', async () => {
    const before = await ledgerCount();
    const result = await core.matching.match(profile, { asOf: new Date('2027-05-10T12:00:00Z') });
    expect(await ledgerCount()).toBe(before);
    expect(result.llmCostUsd).toBe(0);
    expect(result.l3Applied).toBe(false);
    const got = result.matches
      .map((m) => m.programId)
      .filter((id) => id.startsWith(uni))
      .sort();
    expect(got).toEqual([ids.active, ids.baseline].sort());
    const cs = result.matches.find((m) => m.programId === ids.active);
    const power = result.matches.find((m) => m.programId === ids.baseline);
    expect(cs?.similarityMethod).toBe('PG_TRGM');
    expect(cs?.fieldScore).toBeGreaterThan(power?.fieldScore ?? 100);
    expect(cs?.fitTier).toBe('CONDITIONAL'); // June diploma + 60-day national statement > mid-August docs deadline
    expect(cs?.flags.map((f) => f.code)).toEqual(
      expect.arrayContaining([
        'CALENDAR_CRUNCH_WARNING',
        'MINOR_UNDER_18_CONSENTS',
        'RU_SECTOR_TRANSLATION_EXEMPT',
        'BANK_TRANSFER_ONLY',
        'NATIONAL_RECOGNITION_REQUIRED',
      ]),
    );
  });

  it('POST /api/v1/dev/match validates input, pins asOf, and returns the same $0 result', async () => {
    const app = buildApp(core);
    const ok = await app.request('/api/v1/dev/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: profile, asOf: '2027-05-10T12:00:00Z' }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as MatchResult;
    expect(body.asOf).toBe('2027-05-10T12:00:00.000Z');
    expect(body.matches.some((m) => m.programId === ids.active)).toBe(true);

    const late = await app.request('/api/v1/dev/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: profile, asOf: '2027-07-14T00:00:00Z' }),
    });
    const lateBody = (await late.json()) as MatchResult;
    expect(lateBody.excluded.find((e) => e.programId === ids.active)?.reasons).toEqual([
      'DEADLINE_TOO_CLOSE',
    ]);

    const bad = await app.request('/api/v1/dev/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { ...profile, dob: 'yesterday' } }),
    });
    expect(bad.status).toBe(400);
    const missingMonth = Object.fromEntries(
      Object.entries(profile).filter(([k]) => k !== 'expectedDiplomaMonth'),
    );
    expect(
      (
        await app.request('/api/v1/dev/match', {
          method: 'POST',
          body: JSON.stringify({ input: missingMonth }),
        })
      ).status,
    ).toBe(400);
    expect((await app.request('/api/v1/dev/match', { method: 'POST', body: 'not json' })).status).toBe(400);
  });

  it('GET /api/v1/wiki/programs lists matchable programs only', async () => {
    const res = await buildApp(core).request(`/api/v1/wiki/programs?season=${season}&country=PL`);
    expect(res.status).toBe(200);
    const { programs } = (await res.json()) as { programs: Array<{ id: string }> };
    const mine = programs
      .map((p) => p.id)
      .filter((id) => id.startsWith(uni))
      .sort();
    expect(mine).toEqual([ids.active, ids.baseline].sort());
    expect((await buildApp(core).request('/api/v1/wiki/programs?season=bad')).status).toBe(400);
  });

  it('LOW-5: the body cap holds for a chunked (no Content-Length) upload, and dev routes do not exist unless enabled', async () => {
    const app = buildApp(core);
    const big = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i += 1) controller.enqueue(new Uint8Array(16 * 1024).fill(0x20));
        controller.close();
      },
    });
    const res = await app.request('/api/v1/dev/match', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: big,
      duplex: 'half',
    });
    expect(res.status).toBe(413);
    const prod = buildApp({ ...core, devEndpoints: false });
    expect((await prod.request('/api/v1/dev/match', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await prod.request('/healthz')).status).toBe(200);
  });

  it('MEDIUM-4: a QUARANTINED city drops out of the read model and the minor is flagged MINOR_CONSENTS_UNVERIFIED', async () => {
    await writer
      .updateTable('wiki.city_profile')
      .set({ verification_depth: 'QUARANTINED' })
      .where('id', '=', city)
      .execute();
    const result = await core.matching.match(profile, { asOf: new Date('2027-05-10T12:00:00Z') });
    const m = result.matches.find((x) => x.programId === ids.active);
    expect(m?.flags.map((f) => f.code)).toContain('MINOR_CONSENTS_UNVERIFIED');
    expect(m?.fitTier).toBe('CONDITIONAL');
  });
});
