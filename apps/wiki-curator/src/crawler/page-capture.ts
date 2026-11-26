import type { DiscoveredLink, FetchTier, NotFetchedReason, SnapshotErrorCode } from '@prometheus/contracts';
import {
  HtmlExtractionError,
  PdfExtractionError,
  type HtmlExtraction,
  type HtmlExtractorPort,
  type HttpFetcherPort,
  type JsRendererPort,
  type PdfExtractorPort,
} from '@prometheus/infra-ports';
import type { DomainAllowlist } from './allowlist.js';
import { decodeHtml } from './charset.js';
import { formatPageIndexedText } from './page-indexed-text.js';
import { CRAWL_POLICY } from './policy.js';
import { isChallengeGate } from './waf-detector.js';

/**
 * Captures one URL (ENG-T1 §3 rule 2): Tier 1 HTTP first; PDFs go straight to the PDF extractor (never to
 * Playwright); HTML escalates to Tier 2 iff the host is JS_CATALOG or Tier 1 yields < 500 clean chars.
 * Anti-bot challenge gates stop the capture immediately (no retry, no escalation, no bypass).
 */

export type Capture =
  | {
      readonly kind: 'CONTENT';
      readonly tier: FetchTier;
      readonly requestedUrl: string;
      readonly finalUrl: string;
      readonly httpStatus: number;
      readonly contentKind: 'HTML' | 'PDF';
      readonly raw: Uint8Array;
      /** Content-Type the raw bytes were served with (kept as blob metadata; charset matters). */
      readonly rawContentType: string;
      readonly cleanText: string;
      readonly cleanCharCount: number;
      readonly lang: string | null;
      readonly pageCount: number | null;
      readonly links: readonly DiscoveredLink[];
    }
  | {
      readonly kind: 'ERROR';
      readonly tier: FetchTier;
      readonly requestedUrl: string;
      readonly finalUrl: string;
      readonly httpStatus: number;
      readonly errorCode: SnapshotErrorCode;
    }
  | { readonly kind: 'NOT_FETCHED'; readonly reason: NotFetchedReason; readonly detail: string };

export interface CaptureDeps {
  readonly allowlist: DomainAllowlist;
  readonly http: HttpFetcherPort;
  readonly renderer: JsRendererPort;
  readonly pdf: PdfExtractorPort;
  /** Runs out of process in production (sandboxed worker with a hard time limit). */
  readonly html: HtmlExtractorPort;
}

type ExtractionAttempt = { ok: true; value: HtmlExtraction } | { ok: false; capture: Capture };

async function extractOrFail(
  deps: CaptureDeps,
  html: string,
  finalUrl: string,
  contentLanguage: string | undefined,
): Promise<ExtractionAttempt> {
  try {
    return { ok: true, value: await deps.html.extract(html, finalUrl, contentLanguage) };
  } catch (error) {
    if (error instanceof HtmlExtractionError) {
      return {
        ok: false,
        capture: { kind: 'NOT_FETCHED', reason: 'EXTRACTION_FAILED', detail: error.message },
      };
    }
    throw error;
  }
}

function errorCodeForStatus(status: number): SnapshotErrorCode {
  return status === 404 || status === 410 ? 'MISSING_SOURCE_404' : 'HTTP_ERROR_STATUS';
}

export async function capturePage(url: URL, deps: CaptureDeps): Promise<Capture> {
  const t1 = await deps.http.fetch(url);
  if (t1.kind === 'FAILED') return { kind: 'NOT_FETCHED', reason: t1.reason, detail: t1.detail };
  if (t1.kind === 'HOP_REFUSED') {
    return {
      kind: 'ERROR',
      tier: 'TIER1_HTTP',
      requestedUrl: t1.requestedUrl,
      finalUrl: t1.refusedUrl,
      httpStatus: t1.status,
      errorCode: t1.refusal,
    };
  }

  const base = {
    tier: 'TIER1_HTTP' as const,
    requestedUrl: t1.requestedUrl,
    finalUrl: t1.finalUrl,
    httpStatus: t1.status,
  };
  const html = t1.bodyKind === 'HTML' ? decodeHtml(t1.body, t1.headers['content-type']) : undefined;

  if (t1.status >= 300) {
    const waf = isChallengeGate({
      status: t1.status,
      headers: t1.headers,
      html,
      cleanCharCount: undefined,
      minContentChars: CRAWL_POLICY.minTier1CleanChars,
    });
    return {
      kind: 'ERROR',
      ...base,
      errorCode: waf ? 'WAF_CHALLENGE_DETECTED' : errorCodeForStatus(t1.status),
    };
  }

  if (t1.bodyKind === 'PDF') {
    let pdfText;
    try {
      pdfText = await deps.pdf.extract(t1.body);
    } catch (error) {
      if (error instanceof PdfExtractionError) {
        return { kind: 'NOT_FETCHED', reason: 'EXTRACTION_FAILED', detail: `PDF: ${error.message}` };
      }
      throw error;
    }
    const cleanText = formatPageIndexedText(pdfText);
    return {
      kind: 'CONTENT',
      ...base,
      contentKind: 'PDF',
      raw: t1.body,
      rawContentType: 'application/pdf',
      cleanText,
      cleanCharCount: [...cleanText].length,
      lang: null,
      pageCount: pdfText.pageCount,
      links: [],
    };
  }

  if (html === undefined) {
    return {
      kind: 'NOT_FETCHED',
      reason: 'UNSUPPORTED_CONTENT_TYPE',
      detail: t1.headers['content-type'] ?? 'unknown',
    };
  }

  const t1Attempt = await extractOrFail(deps, html, t1.finalUrl, t1.headers['content-language']);
  if (!t1Attempt.ok) return t1Attempt.capture;
  const t1Text = t1Attempt.value;
  if (
    isChallengeGate({
      status: t1.status,
      headers: t1.headers,
      html,
      cleanCharCount: t1Text.cleanCharCount,
      minContentChars: CRAWL_POLICY.minTier1CleanChars,
    })
  ) {
    return { kind: 'ERROR', ...base, errorCode: 'WAF_CHALLENGE_DETECTED' };
  }

  const escalate =
    deps.allowlist.fetchModeFor(new URL(t1.finalUrl)) === 'JS_CATALOG' ||
    t1Text.cleanCharCount < CRAWL_POLICY.minTier1CleanChars;
  if (!escalate) {
    return {
      kind: 'CONTENT',
      ...base,
      contentKind: 'HTML',
      raw: t1.body,
      rawContentType: t1.headers['content-type'] ?? 'text/html',
      cleanText: t1Text.cleanText,
      cleanCharCount: t1Text.cleanCharCount,
      lang: t1Text.lang,
      pageCount: null,
      links: t1Text.links,
    };
  }

  // Render exactly the URL Tier 1 reached; any further navigation is re-checked hop by hop by the renderer.
  const t2 = await deps.renderer.render(new URL(t1.finalUrl));
  if (t2.kind === 'FAILED') return { kind: 'NOT_FETCHED', reason: t2.reason, detail: `tier2: ${t2.detail}` };
  const t2Base = { tier: 'TIER2_PLAYWRIGHT' as const, requestedUrl: t1.requestedUrl };
  if (t2.kind === 'HOP_REFUSED') {
    return {
      kind: 'ERROR',
      ...t2Base,
      finalUrl: t2.refusedUrl,
      httpStatus: t2.status,
      errorCode: t2.refusal,
    };
  }
  if (!deps.allowlist.allows(new URL(t2.finalUrl))) {
    return {
      kind: 'ERROR',
      ...t2Base,
      finalUrl: t2.finalUrl,
      httpStatus: t2.status,
      errorCode: 'DISALLOWED_REDIRECT',
    };
  }
  const t2Attempt = await extractOrFail(deps, t2.html, t2.finalUrl, t2.headers['content-language']);
  if (!t2Attempt.ok) return t2Attempt.capture;
  const t2Text = t2Attempt.value;
  const t2Waf = isChallengeGate({
    status: t2.status,
    headers: t2.headers,
    html: t2.html,
    cleanCharCount: t2Text.cleanCharCount,
    minContentChars: CRAWL_POLICY.minTier1CleanChars,
  });
  if (t2Waf || t2.status >= 300) {
    return {
      kind: 'ERROR',
      ...t2Base,
      finalUrl: t2.finalUrl,
      httpStatus: t2.status,
      errorCode: t2Waf ? 'WAF_CHALLENGE_DETECTED' : errorCodeForStatus(t2.status),
    };
  }
  return {
    kind: 'CONTENT',
    ...t2Base,
    finalUrl: t2.finalUrl,
    httpStatus: t2.status,
    contentKind: 'HTML',
    raw: Buffer.from(t2.html, 'utf8'),
    rawContentType: 'text/html; charset=utf-8', // serialised DOM is always UTF-8
    cleanText: t2Text.cleanText,
    cleanCharCount: t2Text.cleanCharCount,
    lang: t2Text.lang,
    pageCount: null,
    links: t2Text.links,
  };
}
