import {
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import type { BlobStorePort, PutOutcome } from '@prometheus/infra-ports';

export interface S3BlobStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
}

/** MinIO / S3-compatible BlobStorePort. Uses conditional PUT (`If-None-Match: *`) for atomic put-if-absent. */
export class S3BlobStoreAdapter implements BlobStorePort {
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(options: S3BlobStoreOptions) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      forcePathStyle: true,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    });
  }

  async putIfAbsent(key: string, bytes: Uint8Array, contentType: string): Promise<PutOutcome> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          IfNoneMatch: '*',
        }),
      );
      return 'CREATED';
    } catch (error) {
      if (error instanceof S3ServiceException) {
        const status = error.$metadata.httpStatusCode;
        if (status === 412 || error.name === 'PreconditionFailed') return 'EXISTS';
        // Concurrent conditional writes of the same key: the other writer wins with identical bytes.
        if (status === 409 && error.name === 'ConditionalRequestConflict') return 'EXISTS';
      }
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) return new Uint8Array();
      return await res.Body.transformToByteArray();
    } catch (error) {
      if (error instanceof NoSuchKey) return undefined;
      throw error;
    }
  }

  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const obj of res.Contents ?? []) if (obj.Key !== undefined) keys.push(obj.Key);
      token = res.IsTruncated === true ? res.NextContinuationToken : undefined;
    } while (token !== undefined);
    return keys.sort();
  }

  destroy(): void {
    this.client.destroy();
  }
}
