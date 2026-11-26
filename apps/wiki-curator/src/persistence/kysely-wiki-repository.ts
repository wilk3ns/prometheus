import { AllowlistEntry, LayerHint, type SeedCrawlTarget, type SnapshotRecord } from '@prometheus/contracts';
import { withSerializable, type Database, type WikiCrawlTarget } from '@prometheus/db';
import { isUuid, type Uuid } from '@prometheus/kernel';
import type { Selectable } from 'kysely';
import { z } from 'zod';
import type { CrawlTargetRow, WikiRepository } from './wiki-repository.js';

const SeedUrls = z.array(z.string());

export class CorruptRowError extends Error {
  override readonly name = 'CorruptRowError';
}

function toTarget(row: Selectable<WikiCrawlTarget>): CrawlTargetRow {
  if (!isUuid(row.id)) throw new CorruptRowError(`crawl_target ${row.target_key}: id is not a UUID`);
  return {
    id: row.id,
    targetKey: row.target_key,
    layerHint: LayerHint.parse(row.layer_hint),
    seedUrls: SeedUrls.parse(row.seed_urls_json),
    maxDepth: row.max_depth,
    maxPages: row.max_pages,
    active: row.active,
  };
}

/** WikiRepository over a Kysely instance that MUST be connected as `wiki_writer` (see `connectAs`). */
export class KyselyWikiRepository implements WikiRepository {
  constructor(private readonly db: Database) {}

  async loadAllowlist(): Promise<AllowlistEntry[]> {
    const rows = await this.db
      .selectFrom('wiki.official_domain_allowlist')
      .selectAll()
      .orderBy('host')
      .execute();
    return rows.map((r) =>
      AllowlistEntry.parse({
        host: r.host,
        country_iso2: r.country_iso2,
        org_kind: r.org_kind,
        allow_subdomains: r.allow_subdomains,
        default_fetch_mode: r.default_fetch_mode,
        ...(r.notes === null ? {} : { notes: r.notes }),
      }),
    );
  }

  async findTargetByKey(targetKey: string): Promise<CrawlTargetRow | undefined> {
    const row = await this.db
      .selectFrom('wiki.crawl_target')
      .selectAll()
      .where('target_key', '=', targetKey)
      .executeTakeFirst();
    return row ? toTarget(row) : undefined;
  }

  async listActiveTargets(): Promise<CrawlTargetRow[]> {
    const rows = await this.db
      .selectFrom('wiki.crawl_target')
      .selectAll()
      .where('active', '=', true)
      .orderBy('target_key')
      .execute();
    return rows.map(toTarget);
  }

  async insertSnapshot(r: SnapshotRecord): Promise<void> {
    await this.db
      .insertInto('wiki.source_snapshot')
      .values({
        id: r.id,
        target_id: r.target_id,
        requested_url: r.requested_url,
        final_url: r.final_url,
        host: r.host,
        http_status: r.http_status,
        fetch_tier: r.fetch_tier,
        content_kind: r.content_kind,
        detected_lang: r.detected_lang,
        raw_sha256: r.raw_sha256,
        raw_blob_ref: r.raw_blob_ref,
        clean_text_sha256: r.clean_text_sha256,
        clean_text_blob_ref: r.clean_text_blob_ref,
        clean_char_count: r.clean_char_count,
        page_count: r.page_count,
        discovered_links_json: JSON.stringify(r.discovered_links),
        error_code: r.error_code,
        fetched_at: r.fetched_at,
      })
      .execute();
  }

  async markTargetCrawled(targetId: Uuid, at: Date): Promise<void> {
    await this.db
      .updateTable('wiki.crawl_target')
      .set({ last_crawled_at: at })
      .where('id', '=', targetId)
      .execute();
  }

  async deactivateTarget(targetId: Uuid): Promise<void> {
    await this.db
      .updateTable('wiki.crawl_target')
      .set({ active: false })
      .where('id', '=', targetId)
      .execute();
  }

  upsertSeed(
    allowlist: readonly AllowlistEntry[],
    targets: ReadonlyArray<SeedCrawlTarget & { readonly id: Uuid }>,
  ): Promise<{ allowlistUpserted: number; targetsUpserted: number }> {
    return withSerializable(this.db, async (trx) => {
      for (const e of allowlist) {
        const values = {
          country_iso2: e.country_iso2,
          org_kind: e.org_kind,
          allow_subdomains: e.allow_subdomains,
          default_fetch_mode: e.default_fetch_mode,
          notes: e.notes ?? null,
        };
        await trx
          .insertInto('wiki.official_domain_allowlist')
          .values({ host: e.host, ...values })
          .onConflict((oc) => oc.column('host').doUpdateSet(values))
          .execute();
      }
      for (const t of targets) {
        const values = {
          country_iso2: t.country_iso2,
          layer_hint: t.layer_hint,
          seed_urls_json: JSON.stringify(t.seed_urls),
          max_depth: t.max_depth,
          max_pages: t.max_pages,
          active: true,
        };
        await trx
          .insertInto('wiki.crawl_target')
          .values({ id: t.id, target_key: t.target_key, ...values })
          .onConflict((oc) => oc.column('target_key').doUpdateSet(values))
          .execute();
      }
      return { allowlistUpserted: allowlist.length, targetsUpserted: targets.length };
    });
  }
}
