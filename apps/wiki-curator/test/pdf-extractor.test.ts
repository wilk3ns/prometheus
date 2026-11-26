import { describe, expect, it } from 'vitest';
import { PdfExtractionError } from '@prometheus/infra-ports';
import { formatPageIndexedText, PdfjsTextExtractor } from '../src/crawler/pdf-extractor.js';
import { CRAWL_POLICY } from '../src/crawler/policy.js';
import { fixtureFile } from './support/fixtures.js';

describe('[T1-G6] pdf-extractor', () => {
  const extractor = new PdfjsTextExtractor();

  it('extracts page-indexed text from the 2-page fixture PDF without mutating the input bytes', async () => {
    const bytes = new Uint8Array(fixtureFile('sample.pdf'));
    const before = Buffer.from(bytes).toString('hex');
    const pdf = await extractor.extract(bytes);
    expect(Buffer.from(bytes).toString('hex')).toBe(before);
    expect(pdf.pageCount).toBe(2);
    const text = formatPageIndexedText(pdf);
    expect(text).toMatch(/^\[PAGE 1\]\n/);
    expect(text).toContain('PAGE-ONE-MARKER: double room 720 PLN per month');
    expect(text).toContain('\n\n[PAGE 2]\n');
    expect(text.indexOf('PAGE-TWO-MARKER')).toBeGreaterThan(text.indexOf('[PAGE 2]'));
    expect(text.indexOf('PAGE-ONE-MARKER')).toBeLessThan(text.indexOf('[PAGE 2]'));
  });

  it('formats strictly as [PAGE N] blocks separated by one blank line', () => {
    expect(formatPageIndexedText({ pageCount: 2, pages: ['a  b \n\n\n\nc', ''] })).toBe(
      '[PAGE 1]\na b\n\nc\n\n[PAGE 2]\n',
    );
  });

  it('rejects non-PDF bytes with a typed error', async () => {
    await expect(
      extractor.extract(new TextEncoder().encode('<html>not a pdf</html>')),
    ).rejects.toBeInstanceOf(PdfExtractionError);
  });

  it('[HIGH-2] refuses PDFs above the page bound with a typed error', async () => {
    const capped = new PdfjsTextExtractor({ maxPages: 1 });
    await expect(capped.extract(new Uint8Array(fixtureFile('sample.pdf')))).rejects.toThrow(
      /2 pages \(limit 1\)/,
    );
    await expect(capped.extract(new Uint8Array(fixtureFile('sample.pdf')))).rejects.toBeInstanceOf(
      PdfExtractionError,
    );
  });

  it('[HIGH-2] enforces the wall-clock bound with a typed error', async () => {
    const slow = new PdfjsTextExtractor({ timeoutMs: 0 });
    await expect(slow.extract(new Uint8Array(fixtureFile('sample.pdf')))).rejects.toThrow(/exceeded 0 ms/);
  });

  it('default bounds fit the wiki.source_snapshot.page_count smallint', () => {
    expect(CRAWL_POLICY.pdfMaxPages).toBeLessThanOrEqual(32_767);
  });
});
