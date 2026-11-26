import { PdfExtractionError, type PdfExtractorPort, type PdfText } from '@prometheus/infra-ports';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { CRAWL_POLICY } from './policy.js';

/**
 * Page-indexed PDF text (ENG-T1 §3 rule 6). The raw PDF binary is stored untouched by the snapshot store;
 * this adapter only derives deterministic UTF-8 text per page. pdf.js v6 has no eval-based font compiler;
 * XFA, font-face injection and system fonts are disabled, and nothing is fetched from the network.
 * Bounded by page count and wall-clock time; every violation surfaces as PdfExtractionError.
 * (pdf.js runs its worker in-process under Node: the deadline is enforced between pdf.js async steps.)
 */
export interface PdfLimits {
  /** Documents with more pages are refused outright (default 2,000). */
  readonly maxPages?: number;
  /** Wall-clock budget for parse + text extraction (default 60 s). */
  readonly timeoutMs?: number;
}

class PdfDeadline {
  private readonly at: number;
  constructor(private readonly ms: number) {
    this.at = Date.now() + ms;
  }
  /** Races `work` against the remaining budget and fails with PdfExtractionError when it runs out. */
  async race<T>(work: Promise<T>): Promise<T> {
    const remaining = this.at - Date.now();
    if (remaining <= 0) throw new PdfExtractionError(`PDF extraction exceeded ${this.ms} ms`);
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new PdfExtractionError(`PDF extraction exceeded ${this.ms} ms`)),
        remaining,
      );
    });
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class PdfjsTextExtractor implements PdfExtractorPort {
  private readonly maxPages: number;
  private readonly timeoutMs: number;

  constructor(limits: PdfLimits = {}) {
    this.maxPages = limits.maxPages ?? CRAWL_POLICY.pdfMaxPages;
    this.timeoutMs = limits.timeoutMs ?? CRAWL_POLICY.pdfTimeoutMs;
  }

  async extract(bytes: Uint8Array): Promise<PdfText> {
    const deadline = new PdfDeadline(this.timeoutMs);
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
      doc = await deadline.race(task.promise);
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
        const page = await deadline.race(doc.getPage(n));
        const content = await deadline.race(page.getTextContent());
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

/** Collapses runs of whitespace (incl. NBSP) inside each line, trims line ends, caps blank-line runs. */
function normalizePageText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Formats pages strictly as `[PAGE 1]\n<text>\n\n[PAGE 2]\n<text>` (no trailing newline). */
export function formatPageIndexedText(pdf: PdfText): string {
  return pdf.pages.map((text, i) => `[PAGE ${i + 1}]\n${normalizePageText(text)}`).join('\n\n');
}
