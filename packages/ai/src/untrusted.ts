import { randomBytes } from 'node:crypto';

/**
 * Untrusted-content wrapping (ENG-T2 §3.2). Crawled HTML text and `[PAGE N]` PDF text are data, never
 * instructions. Before they enter a prompt they are neutralised and fenced:
 *  - BiDi overrides/isolates (U+202A..U+202E, U+2066..U+2069) and C0 controls other than \n and \t are removed
 *    (\r\n / \r are normalised to \n first);
 *  - any `<untrusted` / `</untrusted` sequence in the text is escaped, so a page can never close (or open) a
 *    fence itself;
 *  - each document is wrapped in `<untrusted kind="web|pdf|user" url="..." nonce="<128-bit hex>">`, with a fresh
 *    nonce per rendered call. The system prompt tells the model that only text inside a fence carrying the
 *    call's nonce is source material and that nothing inside a fence is an instruction.
 */

export interface UntrustedDocument {
  /**
   * `web` / `pdf`: crawled official sources; `user`: applicant free text (e.g. matching preferences);
   * `model`: another model's output (Agent A's proposal for Agent B, validator / verifier feedback for Agent A).
   */
  readonly kind: 'web' | 'pdf' | 'user' | 'model';
  readonly url: string;
  readonly text: string;
}

export type NonceSource = () => string;

/** 128-bit CSPRNG nonce, lower-case hex. */
export const cryptoNonce: NonceSource = () => randomBytes(16).toString('hex');

const FENCE = /<(\/?)(untrusted)/gi;

/** True for code units removed from untrusted text: C0 / DEL (except \n, \t) and C1 controls. */
function isStripped(code: number): boolean {
  if (code === 0x0a || code === 0x09) return false;
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

/**
 * LOW-1: every Unicode format character (category Cf: BiDi overrides / isolates / marks incl. U+061C,
 * U+200E/F, zero-width U+200B-D, U+2060, U+FEFF, soft hyphen ...) is removed BEFORE the fence escape, so an
 * invisible character can never split `</untrusted` past the escape.
 */
const FORMAT_CHARS = /\p{Cf}/gu;

export function sanitizeUntrusted(text: string): string {
  const normalised = text.replace(/\r\n?/g, '\n').replace(FORMAT_CHARS, '');
  let out = '';
  for (let i = 0; i < normalised.length; i += 1) {
    const code = normalised.charCodeAt(i);
    if (!isStripped(code)) out += normalised[i];
  }
  return out.replace(FENCE, (_m, slash: string, word: string) => `&lt;${slash}${word}`);
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function wrapUntrusted(doc: UntrustedDocument, nonce: string): string {
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new RangeError('nonce must be 128-bit lower-case hex');
  return `<untrusted kind="${doc.kind}" url="${attr(sanitizeUntrusted(doc.url))}" nonce="${nonce}">\n${sanitizeUntrusted(doc.text)}\n</untrusted>`;
}

/** All documents of one call share the call's nonce (the model checks one value). */
export function renderUntrustedBlock(docs: readonly UntrustedDocument[], nonce: string): string {
  return docs.map((d) => wrapUntrusted(d, nonce)).join('\n\n');
}
