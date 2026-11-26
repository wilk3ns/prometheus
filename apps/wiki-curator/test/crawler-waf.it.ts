import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_ORIGIN, openHarness, outcomeFor, rowFor, type Harness } from './support/it-harness.js';

describe('[T1-G7] anti-bot gate against fixture-sites/waf-blocked', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await openHarness();
  });
  afterAll(async () => h?.close());

  it('halts cleanly with WAF_CHALLENGE_DETECTED, 0 bytes stored and zero bypass attempts', async () => {
    const report = await h.crawl(['/waf-blocked']);
    expect(outcomeFor(report, '/waf-blocked')).toMatchObject({
      status: 'SNAPSHOT_ERROR_RECORDED',
      errorCode: 'WAF_CHALLENGE_DETECTED',
      httpStatus: 403,
    });
    expect(rowFor(await h.rows(report.targetKey), '/waf-blocked')).toMatchObject({
      content_kind: 'HTTP_ERROR',
      raw_sha256: null,
      raw_blob_ref: null,
      clean_char_count: 0,
    });
    // Exactly one plain request: no retry, no Tier 2 escalation, no browser / solver attempt.
    expect(h.http.requested).toEqual([`${FIXTURE_ORIGIN}/waf-blocked`]);
    expect(h.renderer.rendered).toEqual([]);
    expect(report.fetchedCount).toBe(1);
  });
});
