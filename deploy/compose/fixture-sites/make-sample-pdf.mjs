// Generates public/sample.pdf: a minimal, valid, deterministic 2-page PDF with known strings per page.
// Run: node deploy/compose/fixture-sites/make-sample-pdf.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pages = [
  ['Rector Decree No 83/2026 - Dormitory tariff', 'PAGE-ONE-MARKER: double room 720 PLN per month'],
  ['Annex 2 - Tuition fees for foreign students', 'PAGE-TWO-MARKER: tuition 3000 EUR per year'],
];

const objects = [];
const add = (body) => objects.push(body) && objects.length;

const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
add('PLACEHOLDER_PAGES');
const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
const kids = [];
for (const [title, line] of pages) {
  const content = `BT /F1 18 Tf 72 720 Td (${title}) Tj 0 -30 Td /F1 12 Tf (${line}) Tj ET`;
  const contentObj = add(
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  );
  kids.push(
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentObj} 0 R >>`,
    ),
  );
}
objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
const offsets = [];
objects.forEach((body, i) => {
  offsets.push(Buffer.byteLength(out, 'latin1'));
  out += `${i + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefAt = Buffer.byteLength(out, 'latin1');
out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

writeFileSync(fileURLToPath(new URL('./public/sample.pdf', import.meta.url)), Buffer.from(out, 'latin1'));
