import type { CrawlReport, DiscoveredLink, UrlCrawlOutcome } from '@prometheus/contracts';
import type { ClockPort } from '@prometheus/kernel';
import type { CrawlTargetRow, WikiRepository } from '../persistence/wiki-repository.js';
import type { LinkSelectorPort } from './link-selector.js';
import { type CaptureDeps, capturePage } from './page-capture.js';
import { CRAWL_POLICY } from './policy.js';
import type { SnapshotStore } from './snapshot-store.js';
import { normalizeUrl, parseHttpUrl } from './url.js';

/**
 * Bounded, level-synchronous BFS over one crawl target (ENG-T1 §3 rules 4 + 5).
 *  - depth 0 = seed URLs; links discovered at depth d are fetched at d + 1 only if d + 1 <= max_depth;
 *  - every fetch attempt (including 404s and refusals) counts towards max_pages;
 *  - URLs are deduplicated on their normalised form (requested and final URL);
 *  - only harvested hrefs are followed: selector output is filtered to the harvested set, so a selector
 *    (deterministic now, model-backed in T2) can reorder or drop links but never invent one.
 */

export interface CrawlRunnerDeps {
  readonly capture: CaptureDeps;
  readonly snapshots: SnapshotStore;
  readonly selector: LinkSelectorPort;
  readonly repo: Pick<WikiRepository, 'markTargetCrawled'>;
  readonly clock: ClockPort;
}

export class CrawlRunner {
  constructor(private readonly deps: CrawlRunnerDeps) {}

  async crawl(target: CrawlTargetRow): Promise<CrawlReport> {
    const startedAt = this.deps.clock.now();
    const maxDepth = Math.min(Math.max(target.maxDepth, 0), CRAWL_POLICY.maxDepth);
    const maxPages = Math.min(Math.max(target.maxPages, 1), CRAWL_POLICY.maxPages);
    const outcomes: UrlCrawlOutcome[] = [];
    const seen = new Set<string>();
    let fetched = 0;

    let frontier: string[] = [];
    for (const seed of target.seedUrls) {
      const url = parseHttpUrl(seed);
      if (!url) {
        outcomes.push({
          status: 'NOT_FETCHED',
          url: seed,
          depth: 0,
          reason: 'DISALLOWED_HOST',
          detail: 'not an http(s) URL',
        });
        continue;
      }
      const key = normalizeUrl(url);
      if (seen.has(key)) continue;
      seen.add(key);
      frontier.push(key);
    }

    for (let depth = 0; frontier.length > 0 && fetched < maxPages; depth += 1) {
      const harvested = new Map<string, DiscoveredLink>();
      for (const url of frontier) {
        if (fetched >= maxPages) break;
        fetched += 1;
        const outcome = await this.fetchOne(url, depth, target);
        outcomes.push(outcome.result);
        if (outcome.finalUrl) seen.add(normalizeUrl(outcome.finalUrl));
        if (depth < maxDepth) {
          for (const link of outcome.links) {
            if (!seen.has(link.url) && !harvested.has(link.url)) harvested.set(link.url, link);
          }
        }
      }
      if (depth >= maxDepth || harvested.size === 0) break;
      const ranked = await this.deps.selector.select([...harvested.values()], {
        targetKey: target.targetKey,
        layerHint: target.layerHint,
        nextDepth: depth + 1,
      });
      frontier = [];
      for (const { url } of ranked) {
        if (!harvested.has(url) || seen.has(url)) continue; // never follow a URL that was not harvested
        seen.add(url);
        frontier.push(url);
      }
    }

    const finishedAt = this.deps.clock.now();
    await this.deps.repo.markTargetCrawled(target.id, finishedAt);
    return {
      targetKey: target.targetKey,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      fetchedCount: fetched,
      outcomes,
    };
  }

  private async fetchOne(
    url: string,
    depth: number,
    target: CrawlTargetRow,
  ): Promise<{ result: UrlCrawlOutcome; links: readonly DiscoveredLink[]; finalUrl: string | undefined }> {
    const capture = await capturePage(new URL(url), this.deps.capture);
    if (capture.kind === 'NOT_FETCHED') {
      return {
        result: { status: 'NOT_FETCHED', url, depth, reason: capture.reason, detail: capture.detail },
        links: [],
        finalUrl: undefined,
      };
    }
    if (capture.kind === 'ERROR') {
      const snapshotId = await this.deps.snapshots.persistError(capture, target.id);
      return {
        result: {
          status: 'SNAPSHOT_ERROR_RECORDED',
          url,
          depth,
          snapshotId,
          httpStatus: capture.httpStatus,
          errorCode: capture.errorCode,
        },
        links: [],
        finalUrl: undefined,
      };
    }
    const stored = await this.deps.snapshots.persistContent(capture, target.id);
    return {
      result: {
        status: 'SNAPSHOT_STORED',
        url,
        depth,
        snapshotId: stored.snapshotId,
        finalUrl: capture.finalUrl,
        fetchTier: capture.tier,
        contentKind: capture.contentKind,
        cleanCharCount: capture.cleanCharCount,
        rawBlobRef: stored.rawBlobRef,
        rawBlobCreated: stored.rawBlobCreated,
        textBlobCreated: stored.textBlobCreated,
        discoveredLinkCount: capture.links.length,
      },
      links: capture.links,
      finalUrl: capture.finalUrl,
    };
  }
}
