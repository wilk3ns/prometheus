import { isAbsolute } from 'node:path';
import { z } from 'zod';

const BoolFlag = z.enum(['true', 'false']).transform((v) => v === 'true');
const Port = z.coerce.number().int().min(1).max(65535);
const AbsolutePath = z.string().refine((p) => isAbsolute(p), { message: 'must be an absolute path' });
const Url = z.url({ protocol: /^https?$/ });

const Common = {
  PG_HOST: z.string().min(1),
  PG_PORT: Port,
  PG_DATABASE: z.string().min(1),
  CRAWLER_USER_AGENT: z.string().min(1).default('PrometheusWikiCurator/0.1 (official-source snapshotter)'),
  PROMETHEUS_VAULT_DIR: AbsolutePath.optional(),
  LIVE_CRAWL: z.enum(['0', '1']).default('0'),
  /** LOW-6: Postgres TLS mode for runtime connections built from a URL (DBOS). Default by profile below. */
  PG_SSLMODE: z.enum(['disable', 'require', 'verify-full']).optional(),
};

const LocalEnv = z.object({
  INFRA_PROFILE: z.literal('local'),
  ...Common,
  SECRETS_DIR: AbsolutePath,
  S3_ENDPOINT: Url,
  S3_REGION: z.string().min(1).default('eu-central-1'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  WIKI_SNAPSHOT_BUCKET: z.string().min(3).default('wiki-snapshots'),
  ALLOW_LOCAL_FIXTURE_HOSTS: BoolFlag.default(false),
  // Hostnames the local exemption applies to (comma-separated). Only these may resolve to non-public
  // addresses or use non-default ports; every other host (incl. live official sites) stays strict.
  LOCAL_FIXTURE_HOSTS: z
    .string()
    .default('localhost')
    .transform((v) =>
      v
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h !== ''),
    )
    .pipe(
      z.array(z.string().regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/, { message: 'must be hostnames' })).min(1),
    ),
});

const AzureEnv = z.object({
  INFRA_PROFILE: z.literal('azure'),
  ...Common,
  AZURE_BLOB_ACCOUNT_URL: z.url({ protocol: /^https$/ }),
  AZURE_KEY_VAULT_URL: z.url({ protocol: /^https$/ }),
  WIKI_SNAPSHOT_BUCKET: z.string().min(3).default('wiki-snapshots'),
  // Local fixture hosts are a test-only escape hatch and can never be enabled outside the local profile.
  ALLOW_LOCAL_FIXTURE_HOSTS: z
    .literal('false', { message: 'must be false outside INFRA_PROFILE=local' })
    .optional(),
});

const Env = z.discriminatedUnion('INFRA_PROFILE', [LocalEnv, AzureEnv]);

interface CommonConfig {
  readonly postgres: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    /** `disable` is the default only for INFRA_PROFILE=local; every other profile defaults to `verify-full`. */
    readonly sslmode: 'disable' | 'require' | 'verify-full';
  };
  readonly crawler: {
    readonly userAgent: string;
    readonly allowLocalFixtureHosts: boolean;
    /** Exempted fixture hostnames; always empty unless ALLOW_LOCAL_FIXTURE_HOSTS=true in the local profile. */
    readonly localFixtureHosts: readonly string[];
  };
  readonly snapshotBucket: string;
  readonly vaultDir: string | undefined;
  readonly liveCrawl: boolean;
}

export interface LocalInfraConfig extends CommonConfig {
  readonly profile: 'local';
  readonly secretsDir: string;
  readonly s3: { readonly endpoint: string; readonly region: string; readonly accessKeyId: string };
}

export interface AzureInfraConfig extends CommonConfig {
  readonly profile: 'azure';
  readonly azure: { readonly blobAccountUrl: string; readonly keyVaultUrl: string };
}

export type WikiCuratorConfig = LocalInfraConfig | AzureInfraConfig;

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
  }
}

/** Parses and validates the wiki-curator environment. Error messages name variables, never values. */
export function loadWikiCuratorConfig(env: Readonly<Record<string, string | undefined>>): WikiCuratorConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'INFRA_PROFILE'}: ${issue.message}`),
    );
  }
  const e = parsed.data;
  const common: CommonConfig = {
    postgres: {
      host: e.PG_HOST,
      port: e.PG_PORT,
      database: e.PG_DATABASE,
      sslmode: e.PG_SSLMODE ?? (e.INFRA_PROFILE === 'local' ? 'disable' : 'verify-full'),
    },
    crawler: {
      userAgent: e.CRAWLER_USER_AGENT,
      allowLocalFixtureHosts: e.INFRA_PROFILE === 'local' ? e.ALLOW_LOCAL_FIXTURE_HOSTS : false,
      localFixtureHosts:
        e.INFRA_PROFILE === 'local' && e.ALLOW_LOCAL_FIXTURE_HOSTS ? e.LOCAL_FIXTURE_HOSTS : [],
    },
    snapshotBucket: e.WIKI_SNAPSHOT_BUCKET,
    vaultDir: e.PROMETHEUS_VAULT_DIR,
    liveCrawl: e.LIVE_CRAWL === '1',
  };
  if (e.INFRA_PROFILE === 'local') {
    return {
      ...common,
      profile: 'local',
      secretsDir: e.SECRETS_DIR,
      s3: { endpoint: e.S3_ENDPOINT, region: e.S3_REGION, accessKeyId: e.S3_ACCESS_KEY_ID },
    };
  }
  return {
    ...common,
    profile: 'azure',
    azure: { blobAccountUrl: e.AZURE_BLOB_ACCOUNT_URL, keyVaultUrl: e.AZURE_KEY_VAULT_URL },
  };
}
