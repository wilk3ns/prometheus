import { z } from 'zod';
import { ConfigError } from './env.js';

/** Valkey coordinates for processes that publish / read Slice Cards (ephemeral cache, never authoritative). */
const CacheEnv = z.object({ VALKEY_URL: z.url({ protocol: /^rediss?$/ }) });

export interface CacheConfig {
  readonly valkeyUrl: string;
}

export function loadCacheConfig(env: Readonly<Record<string, string | undefined>>): CacheConfig {
  const parsed = CacheEnv.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'VALKEY_URL'}: ${i.message}`),
    );
  }
  return { valkeyUrl: parsed.data.VALKEY_URL };
}
