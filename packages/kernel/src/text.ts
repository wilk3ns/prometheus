/**
 * The ONE definition of "invisible" text characters, shared by the untrusted-content sanitiser (what a model
 * sees) and the verbatim-quote normaliser (what a quote is matched against), so both sides always agree:
 *  - CRLF / CR are normalised to LF first;
 *  - every Unicode format character (category Cf: soft hyphen, zero-width chars, LRM / RLM / ALM, BiDi
 *    embeddings / overrides / isolates, BOM ...) is removed;
 *  - C0 controls except LF and TAB, DEL, and C1 controls (U+0080..U+009F) are removed.
 */
const FORMAT_CHARS = /\p{Cf}/gu;

function isControl(code: number): boolean {
  if (code === 0x0a || code === 0x09) return false;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

export function stripInvisible(text: string): string {
  const normalised = text.replace(/\r\n?/g, '\n').replace(FORMAT_CHARS, '');
  let out = '';
  for (let i = 0; i < normalised.length; i += 1) {
    if (!isControl(normalised.charCodeAt(i))) out += normalised[i];
  }
  return out;
}
