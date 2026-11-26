import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureFile } from './support/fixtures.js';
import { openHarness, outcomeFor, rowFor, type Harness } from './support/it-harness.js';

describe('[T1-G6] PDF raw capture + page map against fixture-sites/sample.pdf', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await openHarness();
  });
  afterAll(async () => h?.close());

  it.each(['/sample.pdf', '/download'])(
    'stores exact raw PDF bytes in MinIO and [PAGE 1]/[PAGE 2] text with page_count = 2 (%s)',
    async (path) => {
      const report = await h.crawl([path]);
      expect(outcomeFor(report, path)).toMatchObject({
        status: 'SNAPSHOT_STORED',
        contentKind: 'PDF',
        fetchTier: 'TIER1_HTTP',
      });
      const row = rowFor(await h.rows(report.targetKey), path);
      expect(row).toMatchObject({
        content_kind: 'PDF',
        page_count: 2,
        detected_lang: null,
        fetch_tier: 'TIER1_HTTP',
      });
      expect(row.raw_blob_ref).toBe(`wiki-snapshots/raw/${row.raw_sha256}.pdf`);

      const raw = Buffer.from(await h.bytes(row.raw_blob_ref));
      expect(raw.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect(raw.equals(fixtureFile('sample.pdf'))).toBe(true);

      const text = await h.text(row.clean_text_blob_ref);
      expect(text.startsWith('[PAGE 1]\n')).toBe(true);
      const p2 = text.indexOf('\n\n[PAGE 2]\n');
      expect(p2).toBeGreaterThan(0);
      expect(text.slice(0, p2)).toContain('PAGE-ONE-MARKER: double room 720 PLN per month');
      expect(text.slice(p2)).toContain('PAGE-TWO-MARKER: tuition 3000 EUR per year');
    },
  );

  it('never launched Playwright for either PDF', () => {
    expect(h.renderer.rendered).toEqual([]);
  });
});
