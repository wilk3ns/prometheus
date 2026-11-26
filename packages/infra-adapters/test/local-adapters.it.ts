import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { FileSecretsAdapter, S3BlobStoreAdapter, ValkeyCacheAdapter } from '../local/index.js';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`integration env ${name} missing (run via \`pnpm test:it\`)`);
  return v;
}

describe('[T1-G8] S3BlobStoreAdapter against MinIO', async () => {
  const secrets = new FileSecretsAdapter(need('SECRETS_DIR'));
  const store = new S3BlobStoreAdapter({
    endpoint: need('S3_ENDPOINT'),
    region: need('S3_REGION'),
    accessKeyId: need('S3_ACCESS_KEY_ID'),
    secretAccessKey: await secrets.getSecret('s3_secret_access_key'),
    bucket: need('WIKI_SNAPSHOT_BUCKET'),
  });
  const prefix = `it-adapter/${randomUUID()}/`;
  afterAll(() => store.destroy());

  it('putIfAbsent is atomic and idempotent (CREATED then EXISTS, bytes unchanged)', async () => {
    const key = `${prefix}a.txt`;
    expect(await store.putIfAbsent(key, Buffer.from('first'), 'text/plain')).toBe('CREATED');
    expect(await store.putIfAbsent(key, Buffer.from('second'), 'text/plain')).toBe('EXISTS');
    expect(Buffer.from((await store.get(key)) ?? []).toString()).toBe('first');
  });

  it('get returns undefined for a missing key and listKeys is prefix-scoped', async () => {
    expect(await store.get(`${prefix}missing`)).toBeUndefined();
    await store.putIfAbsent(`${prefix}b.txt`, Buffer.from('b'), 'text/plain');
    expect(await store.listKeys(prefix)).toEqual([`${prefix}a.txt`, `${prefix}b.txt`]);
  });
});

describe('ValkeyCacheAdapter against valkey:8', () => {
  const cache = new ValkeyCacheAdapter(need('VALKEY_URL'));
  afterAll(() => cache.close());

  it('set/get/delete with mandatory TTL', async () => {
    const key = `it:${randomUUID()}`;
    await cache.set(key, 'v', 30);
    expect(await cache.get(key)).toBe('v');
    await cache.delete(key);
    expect(await cache.get(key)).toBeUndefined();
    await expect(cache.set(key, 'v', 0)).rejects.toBeInstanceOf(RangeError);
  });
});
