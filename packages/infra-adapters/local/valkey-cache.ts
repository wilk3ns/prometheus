import { Valkey } from 'iovalkey';
import type { CachePort } from '@prometheus/infra-ports';

/** Valkey-backed CachePort. Ephemeral by contract: callers must treat every read as a possible miss. */
export class ValkeyCacheAdapter implements CachePort {
  private readonly client: Valkey;

  constructor(url: string) {
    this.client = new Valkey(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.client.get(key);
    return value ?? undefined;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new RangeError('ttlSeconds must be a positive integer (nothing in Valkey may live forever)');
    }
    await this.client.set(key, value, 'EX', ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}
