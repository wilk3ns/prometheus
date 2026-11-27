import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ConfigError } from './env.js';

/**
 * apps/core configuration. The core connects to Postgres ONLY as `app_core` (password from SecretsPort).
 * Dev/test HTTP endpoints exist only in the local profile and bind to loopback.
 */
const CoreEnv = z.object({
  INFRA_PROFILE: z.literal('local', {
    message: 'apps/core is composable only with INFRA_PROFILE=local before T8',
  }),
  PG_HOST: z.string().min(1),
  PG_PORT: z.coerce.number().int().min(1).max(65535),
  PG_DATABASE: z.string().min(1),
  SECRETS_DIR: z.string().refine((p) => isAbsolute(p), { message: 'must be an absolute path' }),
  CORE_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** L2 query embeddings through RTE-matching.embed (off: pg_trgm only, zero model calls). */
  MATCHING_EMBEDDINGS: z.enum(['on', 'off']).default('off'),
});

export interface CoreConfig {
  readonly postgres: { readonly host: string; readonly port: number; readonly database: string };
  readonly secretsDir: string;
  readonly httpPort: number;
  readonly embeddings: boolean;
  /** Dev/test endpoints (`/api/v1/dev/*`): local profile only (LOW-5). */
  readonly devEndpoints: boolean;
}

export function loadCoreConfig(env: Readonly<Record<string, string | undefined>>): CoreConfig {
  const parsed = CoreEnv.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join('.') || 'INFRA_PROFILE'}: ${i.message}`),
    );
  }
  const e = parsed.data;
  return {
    postgres: { host: e.PG_HOST, port: e.PG_PORT, database: e.PG_DATABASE },
    secretsDir: e.SECRETS_DIR,
    httpPort: e.CORE_HTTP_PORT,
    embeddings: e.MATCHING_EMBEDDINGS === 'on',
    devEndpoints: e.INFRA_PROFILE === 'local',
  };
}
