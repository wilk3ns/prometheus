import type { AllowlistEntry, LayerHint, SeedCrawlTarget, SnapshotRecord } from '@prometheus/contracts';
import type { Uuid } from '@prometheus/kernel';

/** A `wiki.crawl_target` row as the crawler needs it. */
export interface CrawlTargetRow {
  readonly id: Uuid;
  readonly targetKey: string;
  readonly layerHint: LayerHint;
  readonly seedUrls: readonly string[];
  readonly maxDepth: number;
  readonly maxPages: number;
  readonly active: boolean;
}

/** Persistence port of the wiki-curator (implemented over the `wiki_writer` connection only). */
export interface WikiRepository {
  loadAllowlist(): Promise<AllowlistEntry[]>;
  findTargetByKey(targetKey: string): Promise<CrawlTargetRow | undefined>;
  listActiveTargets(): Promise<CrawlTargetRow[]>;
  insertSnapshot(record: SnapshotRecord): Promise<void>;
  markTargetCrawled(targetId: Uuid, at: Date): Promise<void>;
  /** Sets `active = false` (wiki_writer has no DELETE); inactive targets are skipped by `crawl --all`. */
  deactivateTarget(targetId: Uuid): Promise<void>;
  /** Idempotent seed upsert of allowlist + targets, in one transaction. Targets keep their id on re-seed. */
  upsertSeed(
    allowlist: readonly AllowlistEntry[],
    targets: ReadonlyArray<SeedCrawlTarget & { readonly id: Uuid }>,
  ): Promise<{ allowlistUpserted: number; targetsUpserted: number }>;
}
