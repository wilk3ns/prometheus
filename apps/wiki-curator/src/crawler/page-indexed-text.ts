import type { PdfText } from '@prometheus/infra-ports';

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
