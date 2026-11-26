import { deflateSync } from 'node:zlib';

/**
 * A 1-page PDF whose FlateDecode content stream inflates to `inflatedMb` MB of whitespace (plus one real
 * text op). ~1 KB on the wire per MB inflated; pdf.js inflates and lexes it synchronously (~6-7 ms/MB
 * measured), i.e. a genuine, non-preemptible slow step.
 */
export function flateBombPdf(inflatedMb: number): Buffer {
  const inflated = Buffer.alloc(inflatedMb * 1024 * 1024, 0x20);
  inflated.write('BT /F1 12 Tf 72 720 Td (bomb) Tj ET', 0, 'latin1');
  const stream = deflateSync(inflated, { level: 9 });
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'latin1'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'latin1'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
      'latin1',
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
      stream,
      Buffer.from('\nendstream\nendobj\n', 'latin1'),
    ]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n', 'latin1'),
  ];
  let out = Buffer.from('%PDF-1.4\n', 'latin1');
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out = Buffer.concat([out, Buffer.from(`${i + 1} 0 obj\n`, 'latin1'), body]);
  });
  const xref = out.length;
  const table = offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  return Buffer.concat([
    out,
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
      'latin1',
    ),
  ]);
}
