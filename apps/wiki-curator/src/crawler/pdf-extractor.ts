import { PdfExtractionError, type PdfExtractorPort, type PdfText } from '@prometheus/infra-ports';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { CRAWL_POLICY } from './policy.js';

/**
 * Page-indexed PDF text (ENG-T1 §3 rule 6). The raw PDF binary is stored untouched by the snapshot store;
 * this adapter only derives deterministic UTF-8 text per page. pdf.js v6 has no eval-based font compiler;
 * XFA, font-face injection and system fonts are disabled, and nothing is fetched from the network.
 * Pure extraction, bounded by page count. Wall-clock and memory limits are enforced from outside by the
 * extraction sandbox (a worker thread that is terminated), because pdf.js work is not preemptible.
 */
export interface PdfLimits {
  /** Documents with more pages are refused outright (default 2,000). */
  readonly maxPages?: number;
}

export class PdfjsTextExtractor implements PdfExtractorPort {
  private readonly maxPages: number;

  constructor(limits: PdfLimits = {}) {
    this.maxPages = limits.maxPages ?? CRAWL_POLICY.pdfMaxPages;
  }

  async extract(bytes: Uint8Array): Promise<PdfText> {
    // pdf.js transfers/detaches the buffer it is given; never hand it the caller's bytes.
    const data = new Uint8Array(bytes);
    const task = getDocument({
      data,
      enableXfa: false,
      disableFontFace: true,
      useSystemFonts: false,
      stopAtErrors: false,
      verbosity: 0,
    });
    let doc;
    try {
      doc = await task.promise;
    } catch (error) {
      await task.destroy();
      if (error instanceof PdfExtractionError) throw error;
      throw new PdfExtractionError('unreadable PDF', { cause: error });
    }
    try {
      if (doc.numPages > this.maxPages) {
        throw new PdfExtractionError(`PDF has ${doc.numPages} pages (limit ${this.maxPages})`);
      }
      const pages: string[] = [];
      for (let n = 1; n <= doc.numPages; n += 1) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        let text = '';
        for (const item of content.items) {
          if (!('str' in item)) continue;
          text += item.str;
          if (item.hasEOL) text += '\n';
        }
        pages.push(text);
        page.cleanup();
      }
      return { pageCount: doc.numPages, pages };
    } catch (error) {
      if (error instanceof PdfExtractionError) throw error;
      throw new PdfExtractionError('PDF text extraction failed', { cause: error });
    } finally {
      await task.destroy();
    }
  }
}
