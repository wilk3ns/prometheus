/**
 * Anti-bot challenge gate detection (ENG-T1 §3 rule 2, NON-NEGOTIABLE: detect and stop, never bypass).
 *
 * A response is a challenge gate when either
 *  - Cloudflare marks it mitigated (`cf-mitigated: challenge`), or
 *  - its body carries a Turnstile / reCAPTCHA / hCaptcha / Cloudflare challenge-platform marker AND it is a
 *    blocking interstitial: a 403/429/503 status, or a near-empty page (< minContentChars clean chars).
 * The second clause matters: Cloudflare injects `/cdn-cgi/challenge-platform/` scripts into many ordinary
 * pages, and contact forms embed reCAPTCHA; full official pages carrying those must not be dropped.
 */
const CHALLENGE_MARKERS: readonly RegExp[] = [
  /\/cdn-cgi\/challenge-platform\//i,
  /challenges\.cloudflare\.com/i,
  /\bcf-turnstile\b/i,
  /\bcf-chl-/i,
  /\bg-recaptcha\b/i,
  /www\.(google|recaptcha)\.(com|net)\/recaptcha\//i,
  /\bh-captcha\b/i,
  /hcaptcha\.com\/1\/api\.js/i,
];

const BLOCKING_STATUSES: ReadonlySet<number> = new Set([403, 429, 503]);

export interface WafProbe {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Decoded HTML body, if the response was textual. */
  readonly html: string | undefined;
  /** Clean text length of the page, if already extracted. */
  readonly cleanCharCount: number | undefined;
  readonly minContentChars: number;
}

export function isChallengeGate(probe: WafProbe): boolean {
  if ((probe.headers['cf-mitigated'] ?? '').toLowerCase().includes('challenge')) return true;
  if (probe.html === undefined) return false;
  const html = probe.html;
  if (!CHALLENGE_MARKERS.some((re) => re.test(html))) return false;
  if (BLOCKING_STATUSES.has(probe.status)) return true;
  return probe.cleanCharCount !== undefined && probe.cleanCharCount < probe.minContentChars;
}
