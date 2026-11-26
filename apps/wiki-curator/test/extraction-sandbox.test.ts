import { describe, expect, it } from 'vitest';
import { HtmlExtractionError, PdfExtractionError } from '@prometheus/infra-ports';
import { DomainAllowlist } from '../src/crawler/allowlist.js';
import { SandboxedHtmlExtractor, SandboxedPdfExtractor } from '../src/crawler/extraction-sandbox.js';
import { extractHtml } from '../src/crawler/html-extractor.js';
import { fixtureAllowlistEntry, fixtureFile } from './support/fixtures.js';
import { flateBombPdf } from './support/pdf-bomb.js';
import { testSandbox } from './support/sandbox.js';

const allowlist = new DomainAllowlist([fixtureAllowlistEntry('fixture.pw.edu.pl')]);
const HUB = 'http://fixture.pw.edu.pl/hub';
/** Allowance for worker start-up (tsx transpile in tests) and terminate() on top of the hard limit. */
const MARGIN_MS = 2_500;

async function timed<T>(work: Promise<T>): Promise<{ error: unknown; ms: number }> {
  const started = Date.now();
  try {
    await work;
    return { error: undefined, ms: Date.now() - started };
  } catch (error) {
    return { error, ms: Date.now() - started };
  }
}

describe('[MEDIUM c2] extraction sandbox: worker thread with a hard, terminate()-enforced limit', () => {
  const sandbox = testSandbox();

  it('produces exactly the in-process result for a normal page (pure module, wrapper only)', async () => {
    const html = fixtureFile('hub.html').toString('utf8');
    const viaWorker = await new SandboxedHtmlExtractor(sandbox, allowlist).extract(html, HUB, undefined);
    expect(viaWorker).toEqual(JSON.parse(JSON.stringify(extractHtml(html, HUB, allowlist))));
    const pdf = await new SandboxedPdfExtractor(sandbox).extract(new Uint8Array(fixtureFile('sample.pdf')));
    expect(pdf.pageCount).toBe(2);
    expect(pdf.pages[1]).toContain('PAGE-TWO-MARKER');
  });

  it('terminates a pathological 1,000,000-deep page within limit + margin (EXTRACTION_FAILED path)', async () => {
    const depth = 1_000_000;
    const page = `<html><body>${'<div>'.repeat(depth)}deep${'</div>'.repeat(depth)}</body></html>`;
    expect(page.length).toBeLessThan(15 * 1024 * 1024); // fits under the 15 MB body cap: a real input
    const limitMs = 3_000;
    const { error, ms } = await timed(
      new SandboxedHtmlExtractor(sandbox, allowlist, limitMs).extract(page, HUB, undefined),
    );
    expect(error).toBeInstanceOf(HtmlExtractionError);
    expect((error as Error).message).toMatch(/TIMEOUT: extraction exceeded 3000 ms \(worker terminated\)/);
    expect(ms).toBeGreaterThanOrEqual(limitMs - 50);
    expect(ms).toBeLessThan(limitMs + MARGIN_MS);
  }, 30_000);

  it('terminates a real slow pdf.js step (FlateDecode bomb, ~400 MB inflated) within limit + margin', async () => {
    const bomb = flateBombPdf(400); // ~400 KB on the wire; synchronous inflate + lex inside pdf.js
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const limitMs = 800;
    const { error, ms } = await timed(
      new SandboxedPdfExtractor(sandbox, { timeoutMs: limitMs }).extract(new Uint8Array(bomb)),
    );
    expect(error).toBeInstanceOf(PdfExtractionError);
    expect((error as Error).message).toMatch(/TIMEOUT: extraction exceeded 800 ms \(worker terminated\)/);
    expect(ms).toBeGreaterThanOrEqual(limitMs - 50);
    expect(ms).toBeLessThan(limitMs + MARGIN_MS);
  }, 30_000);

  it('the same bomb completes when given enough time (the limit, not the input, ended the run above)', async () => {
    const pdf = await new SandboxedPdfExtractor(sandbox, { timeoutMs: 20_000 }).extract(
      new Uint8Array(flateBombPdf(64)),
    );
    expect(pdf.pages[0]).toContain('bomb');
  }, 30_000);

  it('maps page-cap violations and heap exhaustion to typed errors', async () => {
    await expect(
      new SandboxedPdfExtractor(sandbox, { maxPages: 1 }).extract(new Uint8Array(fixtureFile('sample.pdf'))),
    ).rejects.toThrow(/FAILED: PdfExtractionError: PDF has 2 pages \(limit 1\)/);
    const tiny = testSandbox({ maxOldGenerationSizeMb: 24, maxYoungGenerationSizeMb: 8 });
    const big = `<html><body>${'<p>tuition fee row</p>'.repeat(400_000)}</body></html>`;
    await expect(
      new SandboxedHtmlExtractor(tiny, allowlist, 20_000).extract(big, HUB, undefined),
    ).rejects.toThrow(/CRASHED/);
  }, 60_000);
});
