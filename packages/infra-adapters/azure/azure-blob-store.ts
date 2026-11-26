import { RestError, type ContainerClient } from '@azure/storage-blob';
import type { BlobStorePort, PutOutcome } from '@prometheus/infra-ports';

/**
 * Azure Blob (Germany West Central) BlobStorePort. The authenticated ContainerClient is injected by the
 * composition root (managed identity wiring lands with the T8 Azure profile).
 */
export class AzureBlobStoreAdapter implements BlobStorePort {
  readonly bucket: string;

  constructor(private readonly container: ContainerClient) {
    this.bucket = container.containerName;
  }

  async putIfAbsent(key: string, bytes: Uint8Array, contentType: string): Promise<PutOutcome> {
    try {
      await this.container.getBlockBlobClient(key).uploadData(bytes, {
        conditions: { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: contentType },
      });
      return 'CREATED';
    } catch (error) {
      if (error instanceof RestError && (error.statusCode === 409 || error.statusCode === 412))
        return 'EXISTS';
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      const buffer = await this.container.getBlockBlobClient(key).downloadToBuffer();
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (error) {
      if (error instanceof RestError && error.statusCode === 404) return undefined;
      throw error;
    }
  }

  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    for await (const blob of this.container.listBlobsFlat({ prefix })) keys.push(blob.name);
    return keys.sort();
  }
}
