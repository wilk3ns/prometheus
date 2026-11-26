import type { DiscoveredLink, LayerHint } from '@prometheus/contracts';

/**
 * Decides which harvested links the BFS follows next, and in what order (ENG-T1 §3 rule 5). T1 ships the
 * deterministic keyword scorer; T2 may plug in a cheap model-backed selector behind the same port. The
 * crawl runner treats every selector as untrusted: it only accepts URLs that were actually harvested.
 */
export interface LinkSelectionContext {
  readonly targetKey: string;
  readonly layerHint: LayerHint;
  /** Depth the selected links will be fetched at. */
  readonly nextDepth: number;
}

export interface ScoredLink {
  readonly url: string;
  /** 0..100 relevance. */
  readonly score: number;
}

export interface LinkSelectorPort {
  /** Returns the links worth following, highest priority first. Omitted links are not followed. */
  select(
    candidates: readonly DiscoveredLink[],
    context: LinkSelectionContext,
  ): Promise<readonly ScoredLink[]>;
}

/** Multilingual admission / tuition / housing / recognition vocabulary from ENG-T1 §3 rule 5. */
export const RELEVANCE_KEYWORDS: readonly string[] = [
  'admission',
  'apply',
  'bando',
  'zulassung',
  'rekrutacja',
  'tuition',
  'fee',
  'tasse',
  'cennik',
  'tariffario',
  'scholarship',
  'dsu',
  'stipendium',
  'dorm',
  'accommodation',
  'residenze',
  'akademik',
  'apostille',
  'nawa',
  'cimea',
  'language',
  'ielts',
];

const KEYWORD_POINTS = 25;
const PDF_POINTS = 25;
/**
 * Short keywords are matched per token with an explicit inflection rule, so `fee` hits `fees` but not
 * `feedback`, and `dorm` hits `dorms` / `dormitory`. Longer stems (>= 5 chars) match as substrings, which
 * covers inflections such as `rekrutacji` and compounds such as `tariffario_ING`.
 */
const SHORT_KEYWORD_TOKEN: Readonly<Record<string, RegExp>> = {
  fee: /^fees?$/,
  dsu: /^dsu$/,
  dorm: /^dorm(s|itory|itories)?$/,
  nawa: /^nawa$/,
};

function matches(keyword: string, text: string, words: ReadonlySet<string>): boolean {
  const tokenRule = SHORT_KEYWORD_TOKEN[keyword];
  if (tokenRule === undefined) return text.includes(keyword);
  for (const w of words) if (tokenRule.test(w)) return true;
  return false;
}

/** Links whose path ends in one of these can never become an HTML/PDF snapshot. */
const NON_DOCUMENT_EXT =
  /\.(jpe?g|png|gif|webp|svg|ico|bmp|tiff?|mp[34]|m4a|avi|mov|wmv|webm|ogg|wav|zip|rar|7z|gz|tar|exe|msi|dmg|iso|docx?|xlsx?|pptx?|odt|ods|odp|ics|vcf|css|js|json|xml|rss)$/i;

function haystack(link: DiscoveredLink): string {
  let path = link.url;
  try {
    const u = new URL(link.url);
    path = `${u.pathname} ${u.search}`;
  } catch {
    // harvested URLs are already absolute; keep the raw string if not
  }
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // malformed percent-encoding: score the raw form
  }
  return `${link.anchor_text} ${decoded}`.toLowerCase();
}

function tokens(text: string): ReadonlySet<string> {
  return new Set(text.split(/[^\p{L}\p{N}]+/u).filter((t) => t !== ''));
}

export function scoreLink(link: DiscoveredLink): number {
  const text = haystack(link);
  const words = tokens(text);
  let score = 0;
  for (const keyword of RELEVANCE_KEYWORDS) {
    if (matches(keyword, text, words)) score += KEYWORD_POINTS;
  }
  if (link.is_pdf) score += PDF_POINTS;
  return Math.min(100, score);
}

export function isCrawlableDocumentUrl(url: string): boolean {
  try {
    return !NON_DOCUMENT_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Deterministic selector: drops non-document URLs, ranks the rest by keyword score (desc), ties broken by
 * URL (asc). Zero-score links are kept at the back so dead links (404 healer input) are still recorded
 * when the page budget allows.
 */
export class KeywordLinkSelector implements LinkSelectorPort {
  select(candidates: readonly DiscoveredLink[]): Promise<readonly ScoredLink[]> {
    const ranked = candidates
      .filter((c) => isCrawlableDocumentUrl(c.url))
      .map((c) => ({ url: c.url, score: scoreLink(c) }))
      .sort((a, b) => b.score - a.score || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
    return Promise.resolve(ranked);
  }
}
