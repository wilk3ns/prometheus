import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_ORIGIN, openHarness, outcomeFor, rowFor, type Harness } from './support/it-harness.js';

describe('[T1-G5] Tier 2 Playwright auto-escalation against fixture-sites/js-catalog', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await openHarness();
  });
  afterAll(async () => h?.close());

  it('detects < 500 chars on Tier 1, escalates to TIER2_PLAYWRIGHT and stores the > 1,000-char catalog', async () => {
    const report = await h.crawl(['/js-catalog']);
    expect(h.http.requested).toEqual([`${FIXTURE_ORIGIN}/js-catalog`]); // Tier 1 ran first
    expect(h.renderer.rendered).toEqual([`${FIXTURE_ORIGIN}/js-catalog`]);
    expect(outcomeFor(report, '/js-catalog')).toMatchObject({
      status: 'SNAPSHOT_STORED',
      fetchTier: 'TIER2_PLAYWRIGHT',
      contentKind: 'HTML',
    });
    const row = rowFor(await h.rows(report.targetKey), '/js-catalog');
    expect(row.fetch_tier).toBe('TIER2_PLAYWRIGHT');
    expect(row.clean_char_count).toBeGreaterThan(1000);
    const text = await h.text(row.clean_text_blob_ref);
    expect(text).toContain('# Degree programme catalogue 2027/2028');
    expect(text).toContain('Computer Science MSc');
    expect(text).not.toContain('Loading...');
    const raw = Buffer.from(await h.bytes(row.raw_blob_ref)).toString('utf8');
    expect(raw).toContain('Environmental Science MSc'); // rendered outerHTML, not the shell
  });

  it('re-checks every browser navigation hop: an off-allowlist redirect is refused inside Chromium', async () => {
    const out = await h.renderer.render(new URL(`${FIXTURE_ORIGIN}/offsite`));
    expect(out).toMatchObject({
      kind: 'HOP_REFUSED',
      refusal: 'DISALLOWED_REDIRECT',
      status: 302,
      refusedUrl: 'https://evil.example.com/landing',
    });
  });

  it('follows in-allowlist browser redirects', async () => {
    const out = await h.renderer.render(new URL(`${FIXTURE_ORIGIN}/moved-hub`));
    expect(out).toMatchObject({ kind: 'RENDERED', finalUrl: `${FIXTURE_ORIGIN}/hub`, status: 200 });
  });
});
