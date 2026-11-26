import { z } from 'zod';
import { ContentKind, FetchTier } from './wiki-enums.js';

/** `error_code` values written to `wiki.source_snapshot` (rows that carry an HTTP status). */
export const SnapshotErrorCode = z.enum([
  'MISSING_SOURCE_404',
  'DISALLOWED_REDIRECT',
  'WAF_CHALLENGE_DETECTED',
  'BLOCKED_PRIVATE_ADDRESS',
  'HTTP_ERROR_STATUS',
]);
export type SnapshotErrorCode = z.infer<typeof SnapshotErrorCode>;

/** Reasons a URL produced no snapshot row at all (no HTTP response worth recording was obtained). */
export const NotFetchedReason = z.enum([
  'DISALLOWED_HOST',
  'BLOCKED_PRIVATE_ADDRESS',
  'NETWORK_ERROR',
  'TIMEOUT',
  'BODY_TOO_LARGE',
  'UNSUPPORTED_CONTENT_TYPE',
  'TOO_MANY_REDIRECTS',
  'RENDER_FAILED',
]);
export type NotFetchedReason = z.infer<typeof NotFetchedReason>;

export const DiscoveredLink = z.strictObject({
  anchor_text: z.string(),
  url: z.string(),
  is_pdf: z.boolean(),
});
export type DiscoveredLink = z.infer<typeof DiscoveredLink>;

export const UrlCrawlOutcome = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('SNAPSHOT_STORED'),
    url: z.string(),
    depth: z.int().min(0),
    snapshotId: z.uuid(),
    finalUrl: z.string(),
    fetchTier: FetchTier,
    contentKind: z.enum(['HTML', 'PDF']),
    cleanCharCount: z.int().min(0),
    rawBlobRef: z.string(),
    rawBlobCreated: z.boolean(),
    textBlobCreated: z.boolean(),
    discoveredLinkCount: z.int().min(0),
  }),
  z.strictObject({
    status: z.literal('SNAPSHOT_ERROR_RECORDED'),
    url: z.string(),
    depth: z.int().min(0),
    snapshotId: z.uuid(),
    httpStatus: z.int(),
    errorCode: SnapshotErrorCode,
  }),
  z.strictObject({
    status: z.literal('NOT_FETCHED'),
    url: z.string(),
    depth: z.int().min(0),
    reason: NotFetchedReason,
    detail: z.string(),
  }),
]);
export type UrlCrawlOutcome = z.infer<typeof UrlCrawlOutcome>;

export const CrawlReport = z.strictObject({
  targetKey: z.string(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  fetchedCount: z.int().min(0),
  outcomes: z.array(UrlCrawlOutcome),
});
export type CrawlReport = z.infer<typeof CrawlReport>;

/** Metadata for one `wiki.source_snapshot` row, as handed from the crawler to persistence. */
export const SnapshotRecord = z.strictObject({
  id: z.uuid(),
  target_id: z.uuid().nullable(),
  requested_url: z.string(),
  final_url: z.string(),
  host: z.string(),
  http_status: z.int().min(0).max(999),
  fetch_tier: FetchTier,
  content_kind: ContentKind,
  detected_lang: z.string().max(8).nullable(),
  raw_sha256: z.string().length(64).nullable(),
  raw_blob_ref: z.string().nullable(),
  clean_text_sha256: z.string().length(64).nullable(),
  clean_text_blob_ref: z.string().nullable(),
  clean_char_count: z.int().min(0),
  page_count: z.int().min(1).max(32767).nullable(),
  discovered_links: z.array(DiscoveredLink),
  error_code: SnapshotErrorCode.nullable(),
  fetched_at: z.date(),
});
export type SnapshotRecord = z.infer<typeof SnapshotRecord>;
