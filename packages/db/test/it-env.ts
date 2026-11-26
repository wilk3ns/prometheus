import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DbConnectionOptions, DbRole } from '../src/index.js';

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`integration env ${name} missing (run via \`pnpm test:it\`)`);
  return value;
}

/** Connection options for `role` against the integration database; passwords come from SECRETS_DIR files. */
export function itConnection(role: DbRole): DbConnectionOptions {
  const secret = role === 'wiki_writer' ? 'wiki_writer_db_password' : 'app_core_db_password';
  return {
    host: need('PG_HOST'),
    port: Number(need('PG_PORT')),
    database: need('PG_DATABASE'),
    password: readFileSync(join(need('SECRETS_DIR'), secret), 'utf8').trim(),
    applicationName: `it-${role}`,
  };
}
