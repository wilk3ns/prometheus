import { describe, expect, it } from 'vitest';
import type { AllowlistEntry } from '@prometheus/contracts';
import type { HttpFetcherPort, HttpFetchOutcome, RenderOutcome } from '@prometheus/infra-ports';
import { DomainAllowlist } from '../src/crawler/allowlist.js';
import { capturePage, type CaptureDeps } from '../src/crawler/page-capture.js';
import { CrawlRunner } from '../src/crawler/crawl-runner.js';
import { KeywordLinkSelector } from '../src/crawler/link-selector.js';
import { SnapshotStore } from '../src/crawler/snapshot-store.js';
import { isAllowedByRobots, parseRobots } from '../src/crawler/robots.js';
import { CrawlPoliteness, PoliteHttpFetcher, POLITENESS_POLICY } from '../src/crawler/politeness.js';
import {
  SandboxedHtmlExtractor,
  SandboxedPdfExtractor,
  withinCleanTextCap,
  type SandboxRunner,
} from '../src/crawler/extraction-sandbox.js';
import { REMOVED_SOCKET_APIS } from '../src/crawler/browser-hardening.js';
import {
  MemoryBlobStore,
  MemoryRepo,
  ScriptedHttp,
  ScriptedRenderer,
  clock,
  html,
  ids,
  inProcessHtml,
  longText,
  target,
  twoPagePdf,
} from './support/fakes.js';

const allowlist = new DomainAllowlist([
  {
    host: 'pw.edu.pl',
    country_iso2: 'PL',
    org_kind: 'UNIVERSITY',
    allow_subdomains: true,
    default_fetch_mode: 'HTTP_FIRST',
  } satisfies AllowlistEntry,
  {
    host: 'elte.hu',
    country_iso2: 'HU',
    org_kind: 'UNIVERSITY',
    allow_subdomains: true,
    default_fetch_mode: 'JS_CATALOG',
  } satisfies AllowlistEntry,
]);

function deps(
  http: HttpFetcherPort,
  renderer = new ScriptedRenderer(() => ({ kind: 'FAILED', reason: 'RENDER_FAILED', detail: '' })),
): CaptureDeps {
  return { allowlist, http, renderer, pdf: twoPagePdf, html: inProcessHtml(allowlist) };
}

describe('[T2-G8][Q2] FETCH_TIMEOUT / NETWORK_ERROR are persisted with http_status 0 and NULL raw (D2)', () => {
  const failing = (reason: 'TIMEOUT' | 'NETWORK_ERROR' | 'BODY_TOO_LARGE'): HttpFetcherPort => ({
    fetch: (url) => Promise.resolve({ kind: 'FAILED', requestedUrl: url.href, reason, detail: 'x' }),
  });

  it('TIMEOUT -> ERROR capture FETCH_TIMEOUT, http_status 0', async () => {
    expect(await capturePage(new URL('https://pw.edu.pl/slow'), deps(failing('TIMEOUT')))).toEqual({
      kind: 'ERROR',
      tier: 'TIER1_HTTP',
      requestedUrl: 'https://pw.edu.pl/slow',
      finalUrl: 'https://pw.edu.pl/slow',
      httpStatus: 0,
      errorCode: 'FETCH_TIMEOUT',
    });
  });

  it('NETWORK_ERROR -> ERROR capture NETWORK_ERROR; other failures stay NOT_FETCHED', async () => {
    expect(
      await capturePage(new URL('https://pw.edu.pl/down'), deps(failing('NETWORK_ERROR'))),
    ).toMatchObject({ kind: 'ERROR', httpStatus: 0, errorCode: 'NETWORK_ERROR' });
    expect(
      await capturePage(new URL('https://pw.edu.pl/big'), deps(failing('BODY_TOO_LARGE'))),
    ).toMatchObject({ kind: 'NOT_FETCHED', reason: 'BODY_TOO_LARGE' });
  });

  it('the persisted row stores 0 bytes: every raw/text column is NULL', async () => {
    const repo = new MemoryRepo();
    const blobs = new MemoryBlobStore();
    const runner = new CrawlRunner({
      capture: deps(failing('TIMEOUT')),
      snapshots: new SnapshotStore(blobs, repo, ids(), clock),
      selector: new KeywordLinkSelector(),
      repo,
      clock,
    });
    const report = await runner.crawl(target({ seedUrls: ['https://pw.edu.pl/slow'] }));
    expect(report.outcomes[0]).toMatchObject({
      status: 'SNAPSHOT_ERROR_RECORDED',
      httpStatus: 0,
      errorCode: 'FETCH_TIMEOUT',
    });
    expect(repo.snapshots[0]).toMatchObject({
      http_status: 0,
      content_kind: 'HTTP_ERROR',
      error_code: 'FETCH_TIMEOUT',
      raw_sha256: null,
      raw_blob_ref: null,
      clean_text_sha256: null,
      clean_text_blob_ref: null,
    });
    expect(blobs.puts).toBe(0);
  });
});

describe('[T2-G8][Q3] robots.txt evaluation (`*` group, RFC 9309 matching)', () => {
  const policy = parseRobots(
    [
      '# comment',
      'User-agent: SomeBot',
      'Disallow: /',
      '',
      'User-agent: *',
      'Disallow: /private/',
      'Disallow: /*.php$',
      'Allow: /private/public-fees',
      'Crawl-delay: 3',
    ].join('\n'),
  );
  const ok = (path: string) => isAllowedByRobots(policy, new URL(`https://pw.edu.pl${path}`));

  it('honours Disallow / Allow with longest-match precedence and wildcards for `*`', () => {
    expect(ok('/fees')).toBe(true);
    expect(ok('/private/x')).toBe(false);
    expect(ok('/private/public-fees')).toBe(true);
    expect(ok('/index.php')).toBe(false);
    expect(ok('/index.php?x=1')).toBe(true); // `$` anchors the end
    expect(policy.crawlDelaySeconds).toBe(3);
  });

  it('ignores groups for other agents and treats an empty Disallow as allow-all', () => {
    expect(
      isAllowedByRobots(parseRobots('User-agent: OtherBot\nDisallow: /'), new URL('https://pw.edu.pl/a')),
    ).toBe(true);
    expect(isAllowedByRobots(parseRobots('User-agent: *\nDisallow:'), new URL('https://pw.edu.pl/a'))).toBe(
      true,
    );
  });
});

/** Fake time: sleeps advance the clock instantly, so spacing is asserted exactly and the test is fast. */
function fakeTime() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    nowMs: () => now,
    sleep: (ms: number) => {
      sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    sleeps,
    starts: [] as number[],
    get now() {
      return now;
    },
  };
}

describe('[T2-G8][Q3] per-host politeness: robots + token bucket + Crawl-delay cap', () => {
  function setup(robots: HttpFetchOutcome | ((url: URL) => HttpFetchOutcome), exempt: string[] = []) {
    const time = fakeTime();
    const requested: string[] = [];
    const robotsFetcher: HttpFetcherPort = {
      fetch: (url) => {
        requested.push(url.href);
        return Promise.resolve(typeof robots === 'function' ? robots(url) : robots);
      },
    };
    const inner: HttpFetcherPort = {
      fetch: (url) => {
        time.starts.push(time.now);
        requested.push(url.href);
        return Promise.resolve(html(url.href, `<p>${longText(40)}</p>`));
      },
    };
    const politeness = new CrawlPoliteness({
      robotsFetcher,
      exemptHosts: new Set(exempt),
      nowMs: time.nowMs,
      sleep: time.sleep,
    });
    return { time, requested, fetcher: new PoliteHttpFetcher(inner, politeness) };
  }
  const robotsTxt = (body: string): HttpFetchOutcome => ({
    kind: 'RESPONSE',
    requestedUrl: 'https://pw.edu.pl/robots.txt',
    finalUrl: 'https://pw.edu.pl/robots.txt',
    status: 200,
    headers: { 'content-type': 'text/plain' },
    body: Buffer.from(body),
    bodyKind: 'OTHER',
  });

  it('a URL disallowed for `*` is never requested (ROBOTS_DISALLOWED); robots.txt itself goes through the fetcher', async () => {
    const { fetcher, requested } = setup(robotsTxt('User-agent: *\nDisallow: /private/'));
    expect(await fetcher.fetch(new URL('https://pw.edu.pl/private/x'))).toEqual({
      kind: 'ROBOTS_DISALLOWED',
      requestedUrl: 'https://pw.edu.pl/private/x',
    });
    expect(requested).toEqual(['https://pw.edu.pl/robots.txt']);
  });

  it('404 / unreachable robots.txt allows everything', async () => {
    for (const outcome of [
      { ...robotsTxt(''), status: 404 },
      {
        kind: 'FAILED',
        requestedUrl: 'https://pw.edu.pl/robots.txt',
        reason: 'NETWORK_ERROR',
        detail: 'down',
      } as const,
    ]) {
      const { fetcher } = setup(outcome);
      expect((await fetcher.fetch(new URL('https://pw.edu.pl/private/x'))).kind).toBe('RESPONSE');
    }
  });

  it('robots.txt is cached per origin for 1 h', async () => {
    const { fetcher, requested, time } = setup(robotsTxt('User-agent: *\nDisallow:'));
    await fetcher.fetch(new URL('https://pw.edu.pl/a'));
    await fetcher.fetch(new URL('https://pw.edu.pl/b'));
    expect(requested.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(1);
    await time.sleep(POLITENESS_POLICY.robotsTtlMs + 1);
    await fetcher.fetch(new URL('https://pw.edu.pl/c'));
    expect(requested.filter((u) => u.endsWith('/robots.txt'))).toHaveLength(2);
  });

  it('request starts to one host are spaced >= 1 s (token bucket), and Crawl-delay is honoured but capped at 5 s', async () => {
    const { fetcher, time } = setup(robotsTxt('User-agent: *\nDisallow:'));
    for (const p of ['a', 'b', 'c']) await fetcher.fetch(new URL(`https://pw.edu.pl/${p}`));
    const gaps = time.starts.slice(1).map((t, i) => t - (time.starts[i] ?? 0));
    expect(gaps).toHaveLength(2);
    expect(gaps.every((g) => g >= POLITENESS_POLICY.minIntervalMs)).toBe(true);

    const slow = setup(robotsTxt('User-agent: *\nCrawl-delay: 30'));
    await slow.fetcher.fetch(new URL('https://pw.edu.pl/a'));
    await slow.fetcher.fetch(new URL('https://pw.edu.pl/b'));
    const [first, second] = slow.time.starts;
    expect((second ?? 0) - (first ?? 0)).toBe(POLITENESS_POLICY.maxCrawlDelayMs);
  });

  it('never more than 2 requests in flight per host', async () => {
    let inFlight = 0;
    let peak = 0;
    const inner: HttpFetcherPort = {
      fetch: async (url) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return html(url.href, '<p>x</p>');
      },
    };
    const politeness = new CrawlPoliteness({
      robotsFetcher: { fetch: () => Promise.resolve({ ...robotsTxt(''), status: 404 }) },
      exemptHosts: new Set(),
      sleep: () => Promise.resolve(), // spacing disabled so concurrency is what is measured
    });
    const fetcher = new PoliteHttpFetcher(inner, politeness);
    await Promise.all(Array.from({ length: 8 }, (_, i) => fetcher.fetch(new URL(`https://pw.edu.pl/p${i}`))));
    expect(peak).toBeLessThanOrEqual(POLITENESS_POLICY.maxConcurrencyPerHost);
  });

  it('local fixture hosts are exempt (no robots fetch, no spacing)', async () => {
    const { fetcher, requested, time } = setup(robotsTxt('User-agent: *\nDisallow: /'), ['localhost']);
    await fetcher.fetch(new URL('http://localhost:8088/a'));
    await fetcher.fetch(new URL('http://localhost:8088/b'));
    expect(requested).toEqual(['http://localhost:8088/a', 'http://localhost:8088/b']);
    expect(time.sleeps).toEqual([]);
  });

  it('capturePage persists ROBOTS_DISALLOWED as an http_status 0 error row', async () => {
    const http: HttpFetcherPort = {
      fetch: (url) => Promise.resolve({ kind: 'ROBOTS_DISALLOWED', requestedUrl: url.href }),
    };
    expect(await capturePage(new URL('https://pw.edu.pl/private/x'), deps(http))).toMatchObject({
      kind: 'ERROR',
      httpStatus: 0,
      errorCode: 'ROBOTS_DISALLOWED',
    });
  });

  it('a Tier 2 render refused by robots.txt is persisted the same way', async () => {
    const http = new ScriptedHttp({ 'https://www.elte.hu/spa': (u) => html(u, '<div>shell</div>') });
    const renderer = new ScriptedRenderer((): RenderOutcome => ({ kind: 'ROBOTS_DISALLOWED' }));
    expect(await capturePage(new URL('https://www.elte.hu/spa'), deps(http, renderer))).toMatchObject({
      kind: 'ERROR',
      tier: 'TIER2_PLAYWRIGHT',
      httpStatus: 0,
      errorCode: 'ROBOTS_DISALLOWED',
    });
  });
});

describe('[T2-G8][Q5] T1 LOW fold-ins', () => {
  it('LOW-1: Worker / SharedWorker / ServiceWorker constructors are removed by the init script', () => {
    for (const api of ['Worker', 'SharedWorker', 'ServiceWorker']) expect(REMOVED_SOCKET_APIS).toContain(api);
  });

  it('LOW-2: blocked_proxy_requests_count is surfaced per Tier 2 capture and per crawl', async () => {
    let hits = 0;
    const renderer = new ScriptedRenderer((url) => {
      hits += 2; // the render tripped the fail-closed proxy twice
      return {
        kind: 'RENDERED',
        finalUrl: url,
        status: 200,
        headers: {},
        html: `<html><body><p>${longText(40)}</p></body></html>`,
      };
    });
    renderer.blockedProxyRequests = () => hits;
    const http = new ScriptedHttp({ 'https://www.elte.hu/spa': (u) => html(u, '<div>shell</div>') });
    const repo = new MemoryRepo();
    const runner = new CrawlRunner({
      capture: deps(http, renderer),
      snapshots: new SnapshotStore(new MemoryBlobStore(), repo, ids(), clock),
      selector: new KeywordLinkSelector(),
      repo,
      clock,
    });
    const report = await runner.crawl(target({ seedUrls: ['https://www.elte.hu/spa'], maxDepth: 0 }));
    expect(report.outcomes[0]).toMatchObject({
      status: 'SNAPSHOT_STORED',
      fetchTier: 'TIER2_PLAYWRIGHT',
      blockedProxyRequestsCount: 2,
    });
    expect(report.blockedProxyRequestsCount).toBe(2);
  });

  it('LOW-3: a clean-text reply above 15 MB is rejected as an extraction failure (HTML and PDF)', async () => {
    const big = 'x'.repeat(15 * 1024 * 1024 + 1);
    expect(withinCleanTextCap([big])).toBe(false);
    expect(withinCleanTextCap(['x'.repeat(8 * 1024 * 1024), 'y'.repeat(8 * 1024 * 1024)])).toBe(false);
    expect(withinCleanTextCap(['x'.repeat(1024)])).toBe(true);
    const htmlRunner: SandboxRunner = {
      run: () =>
        Promise.resolve({
          ok: true,
          value: { cleanText: big, cleanCharCount: big.length, links: [], lang: null },
        }),
    };
    await expect(
      new SandboxedHtmlExtractor(htmlRunner, allowlist).extract('<p/>', 'https://pw.edu.pl/', undefined),
    ).rejects.toThrow(/exceeds 15728640 bytes/);
    const pdfRunner: SandboxRunner = {
      run: () => Promise.resolve({ ok: true, value: { pageCount: 2, pages: [big, 'p2'] } }),
    };
    await expect(new SandboxedPdfExtractor(pdfRunner).extract(new Uint8Array())).rejects.toThrow(
      /exceeds 15728640 bytes/,
    );
  });
});
