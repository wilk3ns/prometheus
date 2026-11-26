import { randomUUID } from 'node:crypto';
import { loadWikiCuratorConfig } from '@prometheus/config';
import type { CrawlReport, UrlCrawlOutcome } from '@prometheus/contracts';
import type { WikiSourceSnapshot } from '@prometheus/db';
import type { HttpFetcherPort, JsRendererPort } from '@prometheus/infra-ports';
import type { Selectable } from 'kysely';
import { openRuntime, type CuratorRuntime } from '../../src/bootstrap.js';
import { DomainAllowlist } from '../../src/crawler/allowlist.js';
import { CrawlRunner } from '../../src/crawler/crawl-runner.js';
import { KeywordLinkSelector } from '../../src/crawler/link-selector.js';
import { SandboxedHtmlExtractor, SandboxedPdfExtractor } from '../../src/crawler/extraction-sandbox.js';
import { STRICT_ADDRESS_POLICY } from '../../src/crawler/address-policy.js';
import { GuardedHttpClient, type GuardedHttpOptions } from '../../src/crawler/guarded-http.js';
import { RequestGuard, type Resolver } from '../../src/crawler/request-guard.js';
import { SnapshotStore } from '../../src/crawler/snapshot-store.js';
import { UndiciHttpFetcher } from '../../src/crawler/tier1-http.js';
import { PlaywrightJsRenderer, type Tier2Options } from '../../src/crawler/tier2-playwright.js';
import { fixtureAllowlistEntry } from './fixtures.js';
import { testSandbox } from './sandbox.js';

export const FIXTURE_ORIGIN = process.env['FIXTURE_SITES_ORIGIN'] ?? 'http://localhost:8088';
export const FIXTURE_HOST = new URL(FIXTURE_ORIGIN).hostname;

/** Counts calls through the real adapters so tests can prove which tiers ran. */
export class CountingRenderer implements JsRendererPort {
  readonly rendered: string[] = [];
  constructor(readonly inner: JsRendererPort) {}
  render(url: URL) {
    this.rendered.push(url.href);
    return this.inner.render(url);
  }
  close() {
    return this.inner.close();
  }
}

export class CountingHttp implements HttpFetcherPort {
  readonly requested: string[] = [];
  constructor(readonly inner: HttpFetcherPort) {}
  fetch(url: URL) {
    this.requested.push(url.href);
    return this.inner.fetch(url);
  }
}

export interface HarnessOptions {
  /** Exempt the fixture host from the private-address block (default: true, as in local smoke). */
  readonly exemptFixtureAddresses?: boolean;
  /** Pre-check DNS resolver override (connect-time lookup always uses real DNS). */
  readonly resolver?: Resolver;
  readonly http?: Omit<GuardedHttpOptions, 'userAgent'>;
  readonly tier2?: Tier2Options;
}

export interface Harness {
  readonly runtime: CuratorRuntime;
  readonly http: CountingHttp;
  readonly renderer: CountingRenderer;
  readonly guard: RequestGuard;
  readonly client: GuardedHttpClient;
  crawl(paths: readonly string[], maxDepth?: number): Promise<CrawlReport>;
  rows(targetKey: string): Promise<Selectable<WikiSourceSnapshot>[]>;
  text(ref: string | null): Promise<string>;
  bytes(ref: string | null): Promise<Uint8Array>;
  close(): Promise<void>;
}

/**
 * Real composition (wiki_writer DB, MinIO, undici, Chromium, pdf.js) against the compose fixture site.
 * Mirrors `openCrawlSession`, wrapping the tier adapters with call counters.
 */
export async function openHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const config = loadWikiCuratorConfig(process.env);
  const runtime = await openRuntime(config);
  await runtime.repo.upsertSeed(
    [fixtureAllowlistEntry(FIXTURE_HOST, { notes: 'LOCAL FIXTURE (integration tests)' })],
    [],
  );
  const exempt: ReadonlySet<string> = new Set(config.crawler.localFixtureHosts);
  const allowlist = new DomainAllowlist(await runtime.repo.loadAllowlist(), { nonDefaultPortHosts: exempt });
  const guard = new RequestGuard(
    allowlist,
    opts.exemptFixtureAddresses === false ? STRICT_ADDRESS_POLICY : { nonPublicAllowedHosts: exempt },
    ...(opts.resolver ? [opts.resolver] : []),
  );
  const client = new GuardedHttpClient(guard, { userAgent: config.crawler.userAgent, ...opts.http });
  const http = new CountingHttp(new UndiciHttpFetcher(client));
  const renderer = new CountingRenderer(
    new PlaywrightJsRenderer(client, config.crawler.userAgent, opts.tier2),
  );
  const sandbox = testSandbox();
  const runner = new CrawlRunner({
    capture: {
      allowlist,
      http,
      renderer,
      pdf: new SandboxedPdfExtractor(sandbox),
      html: new SandboxedHtmlExtractor(sandbox, allowlist),
    },
    snapshots: new SnapshotStore(runtime.blobs, runtime.repo, runtime.ids, runtime.clock),
    selector: new KeywordLinkSelector(),
    repo: runtime.repo,
    clock: runtime.clock,
  });

  const keyOf = (ref: string | null): string => {
    if (ref === null) throw new Error('blob ref is null');
    return ref.slice(runtime.blobs.bucket.length + 1);
  };

  return {
    runtime,
    http,
    renderer,
    guard,
    client,
    async crawl(paths, maxDepth = 0) {
      const targetKey = `fixture-it:${randomUUID()}:2027-FALL`;
      await runtime.repo.upsertSeed(
        [],
        [
          {
            id: runtime.ids.next(),
            target_key: targetKey,
            country_iso2: 'PL',
            layer_hint: 'PROGRAM',
            max_depth: maxDepth,
            max_pages: 30,
            seed_urls: paths.map((p) => `${FIXTURE_ORIGIN}${p}`),
          },
        ],
      );
      const target = await runtime.repo.findTargetByKey(targetKey);
      if (!target) throw new Error('seeded target not found');
      return runner.crawl(target);
    },
    async rows(targetKey) {
      const target = await runtime.repo.findTargetByKey(targetKey);
      if (!target) return [];
      return runtime.db
        .selectFrom('wiki.source_snapshot')
        .selectAll()
        .where('target_id', '=', target.id)
        .orderBy('fetched_at')
        .execute();
    },
    async text(ref) {
      return Buffer.from((await runtime.blobs.get(keyOf(ref))) ?? []).toString('utf8');
    },
    async bytes(ref) {
      const b = await runtime.blobs.get(keyOf(ref));
      if (!b) throw new Error(`missing blob ${ref ?? ''}`);
      return b;
    },
    async close() {
      await renderer.close();
      await client.close();
      await runtime.close();
    },
  };
}

/** Canary hit counts recorded by the fixture server (read directly, outside the crawler's guard). */
export async function rawCanary(): Promise<{ tcp: number; udp: number }> {
  const res = await fetch(`${FIXTURE_ORIGIN}/canary-raw`);
  return (await res.json()) as { tcp: number; udp: number };
}

export async function canaryHits(): Promise<Record<string, number>> {
  const res = await fetch(`${FIXTURE_ORIGIN}/canary-hits`);
  return (await res.json()) as Record<string, number>;
}

export function outcomeFor(report: CrawlReport, path: string): UrlCrawlOutcome {
  const found = report.outcomes.find((o) => o.url === `${FIXTURE_ORIGIN}${path}`);
  if (!found) throw new Error(`no outcome for ${path}: ${JSON.stringify(report.outcomes.map((o) => o.url))}`);
  return found;
}

export function rowFor(
  rows: readonly Selectable<WikiSourceSnapshot>[],
  path: string,
): Selectable<WikiSourceSnapshot> {
  const found = rows.find((r) => r.requested_url === `${FIXTURE_ORIGIN}${path}`);
  if (!found) throw new Error(`no snapshot row for ${path}`);
  return found;
}
