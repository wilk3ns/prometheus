// Creates the local-only .secrets/ files (one file per secret name, read by FileSecretsAdapter). Idempotent: never overwrites existing files.
// The values are the dev-only defaults already public in the T1 migration and deploy/compose/compose.yaml.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './env.mjs';

if (process.env.INFRA_PROFILE && process.env.INFRA_PROFILE !== 'local') {
  console.error('init-local-secrets refuses to run outside INFRA_PROFILE=local');
  process.exit(1);
}

const secretsDir = join(REPO_ROOT, '.secrets');
const devSecrets = {
  wiki_writer_db_password: 'dev_wiki_writer',
  app_core_db_password: 'dev_app_core',
  s3_secret_access_key: 'minio-dev-secret',
};

mkdirSync(secretsDir, { recursive: true });
for (const [name, value] of Object.entries(devSecrets)) {
  const file = join(secretsDir, name);
  if (!existsSync(file)) {
    writeFileSync(file, value, { mode: 0o600 });
    console.log(`created .secrets/${name}`);
  }
}

console.log(`local secrets ready in ${secretsDir}`);
