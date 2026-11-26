const META_CHARSET = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_.:-]+)/i;

function decoderFor(label: string | undefined): TextDecoder | undefined {
  if (!label) return undefined;
  try {
    return new TextDecoder(label.trim().toLowerCase());
  } catch {
    return undefined;
  }
}

/**
 * Decodes HTML bytes: BOM, then `Content-Type` charset, then `<meta charset>` in the first 4 KB, else
 * UTF-8. Unknown labels fall through to the next source. Legacy CMSs still serve windows-1250 (PL) and
 * iso-8859-9 (TR), so the label is honoured rather than assuming UTF-8.
 */
export function decodeHtml(bytes: Uint8Array, contentType: string | undefined): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder('utf-8').decode(bytes);
  const headerLabel = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? '')?.[1];
  const sniffed = META_CHARSET.exec(new TextDecoder('latin1').decode(bytes.subarray(0, 4096)))?.[1];
  const decoder = decoderFor(headerLabel) ?? decoderFor(sniffed) ?? new TextDecoder('utf-8');
  return decoder.decode(bytes);
}
