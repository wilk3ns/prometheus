import type { CrawlReport } from '@prometheus/contracts';
import type { CrawlTargetRow } from '../persistence/wiki-repository.js';

export type BatchLine =
  | { readonly targetKey: string; readonly status: 'CRAWLED'; readonly report: CrawlReport }
  | { readonly targetKey: string; readonly status: 'TARGET_FAILED'; readonly error: string };

export interface BatchSummary {
  readonly crawled: number;
  readonly failed: number;
}

/**
 * Crawls targets one after another with per-target failure isolation: a target that throws (e.g. a
 * transient database or blob-store fault) is reported as TARGET_FAILED and the batch moves on, so one
 * broken university never silently drops the rest of the season's crawl.
 */
export async function runCrawlBatch(
  targets: readonly CrawlTargetRow[],
  crawl: (target: CrawlTargetRow) => Promise<CrawlReport>,
  emit: (line: BatchLine) => void,
): Promise<BatchSummary> {
  let crawled = 0;
  let failed = 0;
  for (const target of targets) {
    try {
      emit({ targetKey: target.targetKey, status: 'CRAWLED', report: await crawl(target) });
      crawled += 1;
    } catch (error) {
      failed += 1;
      emit({
        targetKey: target.targetKey,
        status: 'TARGET_FAILED',
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      });
    }
  }
  return { crawled, failed };
}
