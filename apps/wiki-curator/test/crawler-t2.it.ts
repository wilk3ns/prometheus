import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canaryHits,
  FIXTURE_ORIGIN,
  openHarness,
  outcomeFor,
  rowFor,
  type Harness,
} from './support/it-harness.js';

/**
 * [T2-G8] Q2 / Q3 / Q5 fold-ins on the real stack (undici GuardedHttpClient, Chromium, Postgres, MinIO).
 * The fixture site serves `/robots.txt` = `User-agent: * / Disallow: /private/ / Crawl-delay: 2`.
 */
describe('[T2-G8][Q3] robots.txt + per-host politeness through the GuardedHttpClient', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await openHarness({ politeness: true });
  });
  afterAll(async () => h?.close());

  it('a robots-disallowed URL is never requested and is persisted as http_status 0 ROBOTS_DISALLOWED (NULL raw)', async () => {
    const id = randomUUID();
    const path = `/private/${id}`;
    const report = await h.crawl([path]);
    expect(outcomeFor(report, path)).toMatchObject({
      status: 'SNAPSHOT_ERROR_RECORDED',
      httpStatus: 0,
      errorCode: 'ROBOTS_DISALLOWED',
    });
    const row = rowFor(await h.rows(report.targetKey), path);
    expect(row).toMatchObject({
      http_status: 0,
      content_kind: 'HTTP_ERROR',
      error_code: 'ROBOTS_DISALLOWED',
      raw_sha256: null,
      raw_blob_ref: null,
      clean_text_sha256: null,
      clean_text_blob_ref: null,
    });
    expect((await canaryHits())[`private:${path}`] ?? 0).toBe(0); // the fixture never saw the request
  });

  it('allowed pages are fetched with request starts spaced by Crawl-delay (2 s >= 1 s token bucket)', async () => {
    const started = Date.now();
    const report = await h.crawl(['/hub', '/pl/cennik-ds']);
    const elapsed = Date.now() - started;
    expect(report.outcomes.map((o) => o.status)).toEqual(['SNAPSHOT_STORED', 'SNAPSHOT_STORED']);
    // robots.txt is cached from the previous test; two page starts are >= 2 s apart
    expect(elapsed).toBeGreaterThanOrEqual(2_000);
  });
});

describe('[T2-G8][Q2] Tier 1 timeouts are persisted, not dropped', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await openHarness({ http: { timeoutMs: 1_500 } });
  });
  afterAll(async () => h?.close());

  it('a drip-fed page becomes an http_status 0 FETCH_TIMEOUT row with every blob column NULL', async () => {
    const report = await h.crawl(['/drip']);
    expect(outcomeFor(report, '/drip')).toMatchObject({
      status: 'SNAPSHOT_ERROR_RECORDED',
      httpStatus: 0,
      errorCode: 'FETCH_TIMEOUT',
    });
    const row = rowFor(await h.rows(report.targetKey), '/drip');
    expect(row).toMatchObject({
      http_status: 0,
      content_kind: 'HTTP_ERROR',
      raw_sha256: null,
      raw_blob_ref: null,
      clean_text_blob_ref: null,
    });
  });
});

describe('[T2-G8][Q5] Tier 2 worker realms are blocked and proxy hits are reported', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await openHarness();
  });
  afterAll(async () => h?.close());

  it('page scripts see no Worker / SharedWorker constructors, and the render produced 0 fail-closed proxy hits', async () => {
    const id = randomUUID();
    const before = h.renderer.blockedProxyRequests();
    const out = await h.renderer.render(new URL(`${FIXTURE_ORIGIN}/escape-probe?id=${id}`));
    expect(out.kind).toBe('RENDERED');
    const html = out.kind === 'RENDERED' ? out.html : '';
    expect(html).toContain(`data-probe="ran-${id}"`);
    expect(html).toContain('data-workers="undefined/undefined"');
    await new Promise((r) => setTimeout(r, 1_500));
    expect(h.renderer.blockedProxyRequests() - before).toBe(0);
  });

  it('crawl reports carry blockedProxyRequestsCount (0 for a clean JS catalog)', async () => {
    const report = await h.crawl(['/js-catalog']);
    expect(report.blockedProxyRequestsCount).toBe(0);
    expect(outcomeFor(report, '/js-catalog')).toMatchObject({
      status: 'SNAPSHOT_STORED',
      blockedProxyRequestsCount: 0,
    });
  });
});
