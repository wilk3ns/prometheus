import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { connectAs, PG_INSUFFICIENT_PRIVILEGE, pgErrorCode, type Database } from '@prometheus/db';
import { itConnection } from '../../../packages/db/test/it-env.js';

async function sqlstate(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return 'NO_ERROR';
  } catch (error) {
    return pgErrorCode(error);
  }
}

const CHECK_VIOLATION = '23514';
const CITATION = {
  field_path: 'rules_payload_json.x',
  snapshot_id: null,
  source_url: 'https://www.polimi.it/en/x',
  verbatim_quote: 'Paper Apostille is no longer accepted.',
  retrieved_at: '2026-11-26T16:18:00Z',
};

/**
 * [T2-G3] DB role & trigger isolation on the wiki-v2.0 tables (migration 0002, GR-AI-012 single writer,
 * GR-AI-007 citation integrity, append-only revision ledger).
 */
describe('[T2-G3] wiki-v2.0 role isolation and SQL triggers', () => {
  let writer: Database;
  let appCore: Database;
  const tag = randomUUID().slice(0, 8);
  const cityId = `IT-T2IT${tag.toUpperCase()}`;
  const uniId = `t2it-${tag}`;
  const programId = `t2it-${tag}:msc-x`;
  const revisionId = randomUUID();

  beforeAll(async () => {
    writer = await connectAs('wiki_writer', itConnection('wiki_writer'));
    appCore = await connectAs('app_core', itConnection('app_core'));
    await writer
      .insertInto('wiki.city_profile')
      .values({
        id: cityId,
        country_iso2: 'IT',
        city_name_en: 'Test',
        attributes_json: '{}',
        verification_depth: 'BASELINE',
      })
      .execute();
    await writer
      .insertInto('wiki.university')
      .values({
        id: uniId,
        name_en: 'T2 IT University',
        country_iso2: 'IT',
        city_id: cityId,
        institution_type: 'PUBLIC',
        official_domain: 'polimi.it',
        primary_portal_type: 'DIRECT',
        pricing_tier_code: 'T1',
        general_rules_json: '{}',
        verification_depth: 'BASELINE',
      })
      .execute();
    await writer
      .insertInto('wiki.program')
      .values({
        id: programId,
        university_id: uniId,
        name_en: 'X',
        degree_level: 'MASTER',
        field_code: 'CS_IT',
        instruction_language: 'en',
        duration_semesters: 4,
        official_program_url: 'https://www.polimi.it/x',
      })
      .execute();
    await writer
      .insertInto('wiki.node_revision')
      .values({
        id: revisionId,
        layer: 'CITY',
        node_key: cityId,
        version: 1,
        actor: 'HUMAN',
        after_json: '{}',
        reason: 'it',
      })
      .execute();
  });

  afterAll(async () => {
    await writer?.destroy();
    await appCore?.destroy();
  });

  it('app_core INSERT on every wiki-v2.0 table fails 42501', async () => {
    const id = randomUUID();
    const attempts: Array<() => Promise<unknown>> = [
      () =>
        appCore
          .insertInto('wiki.destination_country_rule')
          .values({
            id,
            country_iso2: 'IT',
            admission_season: 'x',
            verification_depth: 'BASELINE',
            rules_payload_json: '{}',
          })
          .execute(),
      () =>
        appCore
          .insertInto('wiki.city_profile')
          .values({
            id: 'IT-EVIL',
            country_iso2: 'IT',
            city_name_en: 'e',
            attributes_json: '{}',
            verification_depth: 'BASELINE',
          })
          .execute(),
      () =>
        appCore
          .insertInto('wiki.origin_equivalency_rule')
          .values({
            id,
            destination_country_iso2: 'IT',
            citizenship_country: 'AZ',
            diploma_origin_country: 'AZ',
            diploma_type: 'IB',
            admission_season: 'x',
            equivalency_policy: 'DIRECT',
            legalization_rules_json: '{}',
            verification_depth: 'BASELINE',
          })
          .execute(),
      () =>
        appCore
          .insertInto('wiki.university')
          .values({
            id: 'evil',
            name_en: 'e',
            country_iso2: 'IT',
            city_id: cityId,
            institution_type: 'PUBLIC',
            official_domain: 'e.it',
            primary_portal_type: 'DIRECT',
            pricing_tier_code: 'T1',
            general_rules_json: '{}',
            verification_depth: 'BASELINE',
          })
          .execute(),
      () =>
        appCore
          .insertInto('wiki.university_housing')
          .values({
            id,
            university_id: uniId,
            rates_season: 'x',
            official_info_url: 'https://x',
            critical_rules_json: '{}',
            verification_depth: 'BASELINE',
          })
          .execute(),
      () =>
        appCore
          .insertInto('wiki.program')
          .values({
            id: 'evil:x',
            university_id: uniId,
            name_en: 'e',
            degree_level: 'MASTER',
            field_code: 'X',
            instruction_language: 'en',
            duration_semesters: 2,
            official_program_url: 'https://x',
          })
          .execute(),
      () =>
        appCore
          .insertInto('wiki.program_embedding')
          .values({ program_id: programId, model_id: 'm', search_text: 's' })
          .execute(),
      () =>
        appCore
          .insertInto('wiki.node_revision')
          .values({
            id,
            layer: 'CITY',
            node_key: 'x',
            version: 1,
            actor: 'HUMAN',
            after_json: '{}',
            reason: 'r',
          })
          .execute(),
    ];
    for (const attempt of attempts) expect(await sqlstate(attempt())).toBe(PG_INSUFFICIENT_PRIVILEGE);
  });

  it('app_core UPDATE on wiki-v2.0 tables fails 42501 (and SELECT works via wiki_reader)', async () => {
    expect(
      await sqlstate(
        appCore
          .updateTable('wiki.university')
          .set({ credit_card_accepted: false })
          .where('id', '=', uniId)
          .execute(),
      ),
    ).toBe(PG_INSUFFICIENT_PRIVILEGE);
    expect(
      await sqlstate(
        appCore
          .updateTable('wiki.city_profile')
          .set({ city_name_en: 'x' })
          .where('id', '=', cityId)
          .execute(),
      ),
    ).toBe(PG_INSUFFICIENT_PRIVILEGE);
    expect(
      await sqlstate(
        appCore.updateTable('wiki.program').set({ name_en: 'x' }).where('id', '=', programId).execute(),
      ),
    ).toBe(PG_INSUFFICIENT_PRIVILEGE);
    expect(
      await sqlstate(
        appCore.updateTable('wiki.program_season_spec').set({ tuition_annual_eur: 0 }).execute(),
      ),
    ).toBe(PG_INSUFFICIENT_PRIVILEGE);
    const rows = await appCore.selectFrom('wiki.university').select('id').where('id', '=', uniId).execute();
    expect(rows).toEqual([{ id: uniId }]);
  });

  it('wiki_writer UPDATE / DELETE / TRUNCATE on wiki.node_revision fails 42501 (append-only even for the writer)', async () => {
    expect(
      await sqlstate(
        writer
          .updateTable('wiki.node_revision')
          .set({ reason: 'tampered' })
          .where('id', '=', revisionId)
          .execute(),
      ),
    ).toBe(PG_INSUFFICIENT_PRIVILEGE);
    expect(
      await sqlstate(writer.deleteFrom('wiki.node_revision').where('id', '=', revisionId).execute()),
    ).toBe(PG_INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(sql`TRUNCATE wiki.node_revision`.execute(writer))).toBe(PG_INSUFFICIENT_PRIVILEGE);
    const still = await writer
      .selectFrom('wiki.node_revision')
      .select('reason')
      .where('id', '=', revisionId)
      .executeTakeFirstOrThrow();
    expect(still.reason).toBe('it');
  });

  it('wiki_writer DELETE on the layer tables fails 42501 (no destructive writes)', async () => {
    expect(await sqlstate(writer.deleteFrom('wiki.university').where('id', '=', uniId).execute())).toBe(
      PG_INSUFFICIENT_PRIVILEGE,
    );
    expect(await sqlstate(writer.deleteFrom('wiki.program').where('id', '=', programId).execute())).toBe(
      PG_INSUFFICIENT_PRIVILEGE,
    );
  });

  const countryRow = (overrides: Record<string, unknown>) => ({
    id: randomUUID(),
    country_iso2: 'IT',
    admission_season: `T2IT-${randomUUID().slice(0, 8)}`,
    verification_depth: 'DEEP_VERIFIED',
    verification_score: '0.970',
    rules_payload_json: '{}',
    citations_json: JSON.stringify([CITATION]),
    ...overrides,
  });

  it('DEEP_VERIFIED with verification_score 0.94 fails 23514', async () => {
    expect(
      await sqlstate(
        writer
          .insertInto('wiki.destination_country_rule')
          .values(countryRow({ verification_score: '0.940' }))
          .execute(),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('DEEP_VERIFIED with empty citations_json fails 23514 (DEEP_VERIFIED_REQUIRES_CITATIONS)', async () => {
    await expect(
      writer
        .insertInto('wiki.destination_country_rule')
        .values(countryRow({ citations_json: '[]' }))
        .execute(),
    ).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      message: expect.stringContaining('DEEP_VERIFIED_REQUIRES_CITATIONS'),
    });
  });

  it('DEEP_VERIFIED with an empty / whitespace verbatim_quote fails 23514 (CITATION_MISSING_FIELDS)', async () => {
    for (const quote of ['', '   ']) {
      await expect(
        writer
          .insertInto('wiki.destination_country_rule')
          .values(countryRow({ citations_json: JSON.stringify([{ ...CITATION, verbatim_quote: quote }]) }))
          .execute(),
      ).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        message: expect.stringContaining('CITATION_MISSING_FIELDS'),
      });
    }
  });

  it('the citation trigger also guards UPDATE promotions on every layer table', async () => {
    // promoting the BASELINE university to DEEP_VERIFIED without citations must fail
    expect(
      await sqlstate(
        writer
          .updateTable('wiki.university')
          .set({ verification_depth: 'DEEP_VERIFIED', verification_score: '0.990' })
          .where('id', '=', uniId)
          .execute(),
      ),
    ).toBe(CHECK_VIOLATION);
    expect(
      await sqlstate(
        writer
          .updateTable('wiki.city_profile')
          .set({ verification_depth: 'DEEP_VERIFIED', verification_score: '0.990' })
          .where('id', '=', cityId)
          .execute(),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it('a valid DEEP_VERIFIED row (score >= 0.950, complete citations) is accepted', async () => {
    expect(
      await sqlstate(
        writer
          .insertInto('wiki.destination_country_rule')
          .values(countryRow({ verification_score: '0.950' }))
          .execute(),
      ),
    ).toBe('NO_ERROR');
  });

  it('BASELINE rows need neither a score nor citations', async () => {
    expect(
      await sqlstate(
        writer
          .insertInto('wiki.destination_country_rule')
          .values(
            countryRow({ verification_depth: 'BASELINE', verification_score: null, citations_json: '[]' }),
          )
          .execute(),
      ),
    ).toBe('NO_ERROR');
  });
});
