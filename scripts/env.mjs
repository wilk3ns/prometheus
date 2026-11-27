// Shared helper for repo tooling (db scripts, integration tests, smoke).
// LOCAL_DEFAULTS mirrors the dev-only coordinates published by deploy/compose/compose.yaml. They are applied
// only to variables that are unset, and never when INFRA_PROFILE is something other than 'local'.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const LOCAL_DEFAULTS = {
  INFRA_PROFILE: 'local',
  PG_HOST: 'localhost',
  PG_PORT: '5432',
  PG_DATABASE: 'prometheus',
  PG_ADMIN_USER: 'postgres',
  PG_ADMIN_PASSWORD: 'postgres_dev',
  VALKEY_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'eu-central-1',
  S3_ACCESS_KEY_ID: 'minio-dev',
  WIKI_SNAPSHOT_BUCKET: 'wiki-snapshots',
  FIXTURE_SITES_ORIGIN: 'http://localhost:8088',
  FIXTURE_CANARY_ORIGIN: 'http://localhost:8089',
  SECRETS_DIR: join(REPO_ROOT, '.secrets'),
  // ENG-T2 §3.4: replay is the default model mode and needs zero API keys (committed cassettes).
  AI_MODE: 'replay',
  AI_CASSETTE_DIR: join(REPO_ROOT, 'cassettes'),
  CORE_HTTP_PORT: '8787',
};

export function applyLocalDefaults(env = process.env) {
  if (env.INFRA_PROFILE !== undefined && env.INFRA_PROFILE !== 'local') {
    throw new Error(`refusing to apply local dev defaults with INFRA_PROFILE=${env.INFRA_PROFILE}`);
  }
  // Keep port-derived coordinates consistent when only the compose port overrides are set.
  const derived = {
    ...(env.MINIO_PORT === undefined ? {} : { S3_ENDPOINT: `http://localhost:${env.MINIO_PORT}` }),
    ...(env.VALKEY_PORT === undefined ? {} : { VALKEY_URL: `redis://localhost:${env.VALKEY_PORT}` }),
    ...(env.FIXTURE_SITES_PORT === undefined
      ? {}
      : { FIXTURE_SITES_ORIGIN: `http://localhost:${env.FIXTURE_SITES_PORT}` }),
    ...(env.FIXTURE_CANARY_PORT === undefined
      ? {}
      : { FIXTURE_CANARY_ORIGIN: `http://localhost:${env.FIXTURE_CANARY_PORT}` }),
  };
  for (const [key, value] of Object.entries({ ...LOCAL_DEFAULTS, ...derived })) {
    if (env[key] === undefined || env[key] === '') env[key] = value;
  }
  return env;
}

export function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/** Superuser/migrator connection URL. Only used by repo tooling (migrations, codegen, test setup). */
export function adminUrl(database = required('PG_DATABASE')) {
  const user = encodeURIComponent(required('PG_ADMIN_USER'));
  const pass = encodeURIComponent(required('PG_ADMIN_PASSWORD'));
  return `postgres://${user}:${pass}@${required('PG_HOST')}:${required('PG_PORT')}/${database}?sslmode=disable`;
}
