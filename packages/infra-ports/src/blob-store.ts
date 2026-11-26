export type PutOutcome = 'CREATED' | 'EXISTS';

/**
 * Object storage bound to one bucket/container. Keys are bucket-relative (`raw/<sha256>.pdf`).
 * Implementations: MinIO/S3 (local), Azure Blob (prod).
 */
export interface BlobStorePort {
  readonly bucket: string;
  /** Writes `bytes` unless an object already exists under `key` (content-addressed idempotency). */
  putIfAbsent(key: string, bytes: Uint8Array, contentType: string): Promise<PutOutcome>;
  /** Returns the object bytes, or `undefined` when no object exists under `key`. */
  get(key: string): Promise<Uint8Array | undefined>;
  /** Lists every key under `prefix` (bucket-relative), in lexical order. */
  listKeys(prefix: string): Promise<string[]>;
}

/** Canonical `<bucket>/<key>` reference persisted in database rows. */
export function blobRef(store: Pick<BlobStorePort, 'bucket'>, key: string): string {
  return `${store.bucket}/${key}`;
}
