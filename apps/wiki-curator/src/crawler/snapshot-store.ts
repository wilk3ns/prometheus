import type { SnapshotRecord } from '@prometheus/contracts';
import { blobRef, type BlobStorePort } from '@prometheus/infra-ports';
import { sha256Hex, type ClockPort, type IdGen, type Uuid } from '@prometheus/kernel';
import type { WikiRepository } from '../persistence/wiki-repository.js';
import type { Capture } from './page-capture.js';

/**
 * Content-addressed snapshot persistence (ENG-T1 §4).
 *  raw  -> `raw/<sha256(rawBytes)>.(html|pdf)`
 *  text -> `text/<sha256(utf8(cleanText))>.txt`
 * Existing objects are never re-uploaded (atomic put-if-absent), but every capture still records its own
 * timestamped `wiki.source_snapshot` row. Blobs are written before the row, so a row never references a
 * missing object; a crash in between leaves only a harmless, re-usable orphan blob.
 * Error captures (404/410, disallowed redirects, WAF gates, other HTTP errors) store 0 bytes.
 */

export interface StoredContentSnapshot {
  readonly snapshotId: Uuid;
  readonly rawBlobRef: string;
  readonly rawBlobCreated: boolean;
  readonly textBlobCreated: boolean;
}

type ContentCapture = Extract<Capture, { kind: 'CONTENT' }>;
type ErrorCapture = Extract<Capture, { kind: 'ERROR' }>;

export class SnapshotStore {
  constructor(
    private readonly blobs: BlobStorePort,
    private readonly repo: Pick<WikiRepository, 'insertSnapshot'>,
    private readonly ids: IdGen,
    private readonly clock: ClockPort,
  ) {}

  private common(capture: ContentCapture | ErrorCapture, targetId: Uuid | null) {
    return {
      id: this.ids.next(),
      target_id: targetId,
      requested_url: capture.requestedUrl,
      final_url: capture.finalUrl,
      host: new URL(capture.finalUrl).hostname,
      http_status: capture.httpStatus,
      fetch_tier: capture.tier,
      fetched_at: this.clock.now(),
    };
  }

  /** Records an error capture with 0 bytes stored. */
  async persistError(capture: ErrorCapture, targetId: Uuid | null): Promise<Uuid> {
    const common = this.common(capture, targetId);
    const record: SnapshotRecord = {
      ...common,
      content_kind: 'HTTP_ERROR',
      detected_lang: null,
      raw_sha256: null,
      raw_blob_ref: null,
      clean_text_sha256: null,
      clean_text_blob_ref: null,
      clean_char_count: 0,
      page_count: null,
      discovered_links: [],
      error_code: capture.errorCode,
    };
    await this.repo.insertSnapshot(record);
    return common.id;
  }

  async persistContent(capture: ContentCapture, targetId: Uuid | null): Promise<StoredContentSnapshot> {
    const common = this.common(capture, targetId);
    const ext = capture.contentKind === 'PDF' ? 'pdf' : 'html';
    const rawSha = sha256Hex(capture.raw);
    const textSha = sha256Hex(capture.cleanText);
    const rawKey = `raw/${rawSha}.${ext}`;
    const textKey = `text/${textSha}.txt`;
    const rawPut = await this.blobs.putIfAbsent(rawKey, capture.raw, capture.rawContentType);
    const textPut = await this.blobs.putIfAbsent(
      textKey,
      Buffer.from(capture.cleanText, 'utf8'),
      'text/plain; charset=utf-8',
    );
    const rawRef = blobRef(this.blobs, rawKey);

    await this.repo.insertSnapshot({
      ...common,
      content_kind: capture.contentKind,
      detected_lang: capture.lang,
      raw_sha256: rawSha,
      raw_blob_ref: rawRef,
      clean_text_sha256: textSha,
      clean_text_blob_ref: blobRef(this.blobs, textKey),
      clean_char_count: capture.cleanCharCount,
      page_count: capture.pageCount,
      discovered_links: [...capture.links],
      error_code: null,
    });
    return {
      snapshotId: common.id,
      rawBlobRef: rawRef,
      rawBlobCreated: rawPut === 'CREATED',
      textBlobCreated: textPut === 'CREATED',
    };
  }
}
