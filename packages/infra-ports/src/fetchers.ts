import type { NotFetchedReason } from '@prometheus/contracts';

/** Why a redirect / navigation hop was refused before any body was read. */
export type HopRefusal = 'DISALLOWED_REDIRECT' | 'BLOCKED_PRIVATE_ADDRESS';

export type SniffedBodyKind = 'HTML' | 'PDF' | 'OTHER';

export type HttpFetchOutcome =
  | {
      readonly kind: 'RESPONSE';
      readonly requestedUrl: string;
      readonly finalUrl: string;
      readonly status: number;
      /** Lower-cased header names. */
      readonly headers: Readonly<Record<string, string>>;
      readonly body: Uint8Array;
      readonly bodyKind: SniffedBodyKind;
    }
  | {
      readonly kind: 'HOP_REFUSED';
      readonly requestedUrl: string;
      /** Status of the response that pointed at the refused URL (a 3xx). */
      readonly status: number;
      readonly refusedUrl: string;
      readonly refusal: HopRefusal;
    }
  | {
      readonly kind: 'FAILED';
      readonly requestedUrl: string;
      readonly reason: NotFetchedReason;
      readonly detail: string;
    };

/** Tier 1: plain HTTP GET with per-hop policy checks and body sniffing. */
export interface HttpFetcherPort {
  fetch(url: URL): Promise<HttpFetchOutcome>;
}

export type RenderOutcome =
  | {
      readonly kind: 'RENDERED';
      readonly finalUrl: string;
      readonly status: number;
      readonly headers: Readonly<Record<string, string>>;
      readonly html: string;
    }
  | {
      readonly kind: 'HOP_REFUSED';
      readonly status: number;
      readonly refusedUrl: string;
      readonly refusal: HopRefusal;
    }
  | { readonly kind: 'FAILED'; readonly reason: NotFetchedReason; readonly detail: string };

/** Tier 2: headless browser rendering for JS/AJAX catalogs. */
export interface JsRendererPort {
  render(url: URL): Promise<RenderOutcome>;
  close(): Promise<void>;
}

export interface PdfText {
  readonly pageCount: number;
  /** Extracted UTF-8 text per page, index 0 = page 1. */
  readonly pages: readonly string[];
}

export class PdfExtractionError extends Error {
  override readonly name = 'PdfExtractionError';
}

export interface PdfExtractorPort {
  /** @throws PdfExtractionError when the bytes are not a readable PDF. */
  extract(bytes: Uint8Array): Promise<PdfText>;
}
