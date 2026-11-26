import { PdfExtractionError, type PdfExtractorPort, type PdfText } from '@prometheus/infra-ports';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/**
 * Page-indexed PDF text (ENG-T1 §3 rule 6). The raw PDF binary is stored untouched by the snapshot store;
 * this adapter only derives deterministic UTF-8 text per page. pdf.js v6 has no eval-based font compiler;
 * XFA, font-face injection and system fonts are disabled, and nothing is fetched from the network.
 */
export class PdfjsTextExtractor implements PdfExtractorPort {
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
      throw new PdfExtractionError('unreadable PDF', { cause: error });
    }
    try {
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
