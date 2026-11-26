import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { connectAs, PG_INSUFFICIENT_PRIVILEGE, pgErrorCode, type Database } from '../src/index.js';
import { itConnection } from './it-env.js';

async function sqlstate(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return 'NO_ERROR';
  } catch (error) {
    return pgErrorCode(error);
  }
}

describe('[T1-G3] DB role isolation (GR-AI-012 single-writer)', () => {
  let writer: Database;
  let appCore: Database;
  const targetId = randomUUID();
  const snapshotId = randomUUID();
  const host = `roles-it-${targetId.slice(0, 8)}.pw.edu.pl`;

  beforeAll(async () => {
    writer = await connectAs('wiki_writer', itConnection('wiki_writer'));
    appCore = await connectAs('app_core', itConnection('app_core'));
    await writer
      .insertInto('wiki.official_domain_allowlist')
      .values({ host, country_iso2: 'PL', org_kind: 'UNIVERSITY' })
      .execute();
    await writer
      .insertInto('wiki.crawl_target')
      .values({
        id: targetId,
        target_key: `roles-it:${targetId}`,
        country_iso2: 'PL',
        layer_hint: 'PROGRAM',
        seed_urls_json: JSON.stringify([`https://${host}/`]),
      })
      .execute();
    await writer
      .insertInto('wiki.source_snapshot')
      .values({
        id: snapshotId,
        target_id: targetId,
        requested_url: `https://${host}/`,
        final_url: `https://${host}/`,
        host,
        http_status: 404,
        fetch_tier: 'TIER1_HTTP',
        content_kind: 'HTTP_ERROR',
        error_code: 'MISSING_SOURCE_404',
      })
      .execute();
  });

  afterAll(async () => {
    await writer?.destroy();
    await appCore?.destroy();
  });

  it('app_core SELECT on wiki.source_snapshot succeeds (via wiki_reader)', async () => {
    const rows = await appCore
      .selectFrom('wiki.source_snapshot')
      .select(['id'])
      .where('id', '=', snapshotId)
      .execute();
    expect(rows).toEqual([{ id: snapshotId }]);
  });

  it('app_core INSERT / UPDATE / DELETE on wiki.source_snapshot fail with 42501', async () => {
    expect(
      await sqlstate(
        appCore
          .insertInto('wiki.source_snapshot')
          .values({
            id: randomUUID(),
            requested_url: 'x',
            final_url: 'x',
            host: 'x',
            http_status: 200,
            fetch_tier: 'TIER1_HTTP',
            content_kind: 'HTML',
          })
          .execute(),
      ),
    ).toBe(PG_INSUFFICIENT_PRIVILEGE);
    expect(
      await sqlstate(
        appCore
          .updateTable('wiki.source_snapshot')
          .set({ http_status: 200 })
          .where('id', '=', snapshotId)
          .execute(),
      ),
    ).toBe(PG_INSUFFICIENT_PRIVILEGE);
    expect(
      await sqlstate(appCore.deleteFrom('wiki.source_snapshot').where('id', '=', snapshotId).execute()),
    ).toBe(PG_INSUFFICIENT_PRIVILEGE);
  });

  it('app_core INSERT / UPDATE / DELETE on wiki.official_domain_allowlist fail with 42501', async () => {
    expect(
      await sqlstate(
        appCore
          .insertInto('wiki.official_domain_allowlist')
          .values({ host: 'evil.example.com', country_iso2: 'PL', org_kind: 'UNIVERSITY' })
          .execute(),
      ),
    ).toBe(PG_INSUFFICIENT_PRIVILEGE);
    expect(
      await sqlstate(
        appCore
          .updateTable('wiki.official_domain_allowlist')
          .set({ allow_subdomains: false })
          .where('host', '=', host)
          .execute(),
      ),
    ).toBe(PG_INSUFFICIENT_PRIVILEGE);
    expect(
      await sqlstate(appCore.deleteFrom('wiki.official_domain_allowlist').where('host', '=', host).execute()),
    ).toBe(PG_INSUFFICIENT_PRIVILEGE);
  });

  it('app_core cannot write wiki.crawl_target either', async () => {
    expect(
      await sqlstate(
        appCore.updateTable('wiki.crawl_target').set({ active: false }).where('id', '=', targetId).execute(),
      ),
    ).toBe(PG_INSUFFICIENT_PRIVILEGE);
  });

  it('wiki_writer DELETE / TRUNCATE on wiki.source_snapshot fail with 42501', async () => {
    expect(
      await sqlstate(writer.deleteFrom('wiki.source_snapshot').where('id', '=', snapshotId).execute()),
    ).toBe(PG_INSUFFICIENT_PRIVILEGE);
    expect(await sqlstate(sql`TRUNCATE wiki.source_snapshot`.execute(writer))).toBe(
      PG_INSUFFICIENT_PRIVILEGE,
    );
    const still = await writer
      .selectFrom('wiki.source_snapshot')
      .select('id')
      .where('id', '=', snapshotId)
      .execute();
    expect(still).toHaveLength(1);
  });

  it('connectAs authenticates strictly as the requested role', async () => {
    const wrongSecret = { ...itConnection('wiki_writer'), password: itConnection('app_core').password };
    expect(await sqlstate(connectAs('wiki_writer', wrongSecret))).toBe('28P01');
  });
});
