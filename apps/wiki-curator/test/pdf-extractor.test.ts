import { describe, expect, it } from 'vitest';
import { PdfExtractionError } from '@prometheus/infra-ports';
import { formatPageIndexedText, PdfjsTextExtractor } from '../src/crawler/pdf-extractor.js';
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
});
