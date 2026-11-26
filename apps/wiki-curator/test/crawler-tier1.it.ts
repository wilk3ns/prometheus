import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CrawlReport } from '@prometheus/contracts';
import { FIXTURE_ORIGIN, openHarness, outcomeFor, rowFor, type Harness } from './support/it-harness.js';

describe('[T1-G4] Tier 1 + table + multilingual links against fixture-sites/hub', () => {
  let h: Harness;
  let report: CrawlReport;

  beforeAll(async () => {
    h = await openHarness();
    report = await h.crawl(['/hub'], 1);
  });
  afterAll(async () => h?.close());

  it('fetches /hub with TIER1_HTTP (no escalation) and stores a content-addressed snapshot', async () => {
    expect(outcomeFor(report, '/hub')).toMatchObject({
      status: 'SNAPSHOT_STORED',
      fetchTier: 'TIER1_HTTP',
      contentKind: 'HTML',
    });
    const row = rowFor(await h.rows(report.targetKey), '/hub');
    expect(row).toMatchObject({
      fetch_tier: 'TIER1_HTTP',
      content_kind: 'HTML',
      http_status: 200,
      detected_lang: 'en',
    });
    expect(row.raw_blob_ref).toBe(`wiki-snapshots/raw/${row.raw_sha256}.html`);
    expect(row.clean_text_blob_ref).toBe(`wiki-snapshots/text/${row.clean_text_sha256}.txt`);
    expect(h.renderer.rendered).not.toContain(`${FIXTURE_ORIGIN}/hub`);
  });

  it('preserves the tuition <table> as a Markdown | ... | table in the stored clean text', async () => {
    const row = rowFor(await h.rows(report.targetKey), '/hub');
    const text = await h.text(row.clean_text_blob_ref);
    expect(text).toContain(
      '| Programme | Level | Fee per year |\n| --- | --- | --- |\n| Computer Science | B.Sc. | EUR 3,000 |',
    );
    expect(text).not.toContain('We use cookies');
    expect(row.clean_char_count).toBe([...text].length);
  });

  it('harvests the local-language /pl/cennik-ds page and /sample.pdf, and follows them', async () => {
    const rows = await h.rows(report.targetKey);
    const urls = (rowFor(rows, '/hub').discovered_links_json as Array<{ url: string }>).map((l) => l.url);
    expect(urls).toContain(`${FIXTURE_ORIGIN}/pl/cennik-ds`);
    expect(urls).toContain(`${FIXTURE_ORIGIN}/sample.pdf`);
    expect(urls.every((u) => u.startsWith(FIXTURE_ORIGIN))).toBe(true);
    expect(outcomeFor(report, '/pl/cennik-ds')).toMatchObject({ status: 'SNAPSHOT_STORED', depth: 1 });
    expect(rowFor(rows, '/pl/cennik-ds').detected_lang).toBe('pl');
    expect(outcomeFor(report, '/sample.pdf')).toMatchObject({
      status: 'SNAPSHOT_STORED',
      contentKind: 'PDF',
    });
  });

  it('records /broken-404 as MISSING_SOURCE_404 without crashing the crawl', async () => {
    expect(outcomeFor(report, '/broken-404')).toMatchObject({
      status: 'SNAPSHOT_ERROR_RECORDED',
      errorCode: 'MISSING_SOURCE_404',
      httpStatus: 404,
    });
    expect(rowFor(await h.rows(report.targetKey), '/broken-404')).toMatchObject({
      content_kind: 'HTTP_ERROR',
      error_code: 'MISSING_SOURCE_404',
      raw_sha256: null,
      raw_blob_ref: null,
    });
  });

  it('blocks /offsite -> evil.example.com with DISALLOWED_REDIRECT and 0 bytes stored', async () => {
    expect(outcomeFor(report, '/offsite')).toMatchObject({
      status: 'SNAPSHOT_ERROR_RECORDED',
      errorCode: 'DISALLOWED_REDIRECT',
      httpStatus: 302,
    });
    expect(rowFor(await h.rows(report.targetKey), '/offsite')).toMatchObject({
      error_code: 'DISALLOWED_REDIRECT',
      final_url: 'https://evil.example.com/landing',
      raw_sha256: null,
      raw_blob_ref: null,
      clean_text_blob_ref: null,
      clean_char_count: 0,
    });
  });

  it('follows same-allowlist redirects and records the final URL', async () => {
    const r = await h.crawl(['/moved-hub']);
    expect(outcomeFor(r, '/moved-hub')).toMatchObject({
      status: 'SNAPSHOT_STORED',
      finalUrl: `${FIXTURE_ORIGIN}/hub`,
    });
  });
});

describe('[T1-G4] SSRF guard on real DNS: loopback fixture refused unless ALLOW_LOCAL_FIXTURE_HOSTS', () => {
  it('refuses the allowlisted-but-loopback host when non-public addresses are not allowed', async () => {
    const strict = await openHarness({ allowNonPublic: false });
    try {
      const report = await strict.crawl(['/hub']);
      expect(report.outcomes).toEqual([
        expect.objectContaining({ status: 'NOT_FETCHED', reason: 'BLOCKED_PRIVATE_ADDRESS' }),
      ]);
      expect(await strict.rows(report.targetKey)).toEqual([]);
    } finally {
      await strict.close();
    }
  });
});
