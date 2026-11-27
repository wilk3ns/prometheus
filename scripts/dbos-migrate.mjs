// Provisions the DBOS Transact system schema (`dbos`) with the privileged migrator role, then grants the
// curator's runtime role access to it. Runtime processes launch DBOS with `runMigrations: false`, so no
// application role ever needs DDL rights (ENG-01 §1 durable workflows; ENG-T2 §4).
//   node scripts/dbos-migrate.mjs <database>
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, adminUrl, applyLocalDefaults } from './env.mjs';

applyLocalDefaults();
const database = process.argv[2];
if (!database) {
  console.error('usage: node scripts/dbos-migrate.mjs <database>');
  process.exit(2);
}
// The SDK is a dependency of the only workflow host (apps/wiki-curator); resolve it from there.
const requireFromCurator = createRequire(`${REPO_ROOT}apps/wiki-curator/package.json`);
const { DBOS } = await import(pathToFileURL(requireFromCurator.resolve('@dbos-inc/dbos-sdk')).href);
await DBOS.migrate(adminUrl(database), { schemaName: 'dbos', applicationRole: 'wiki_writer' });
console.log(`dbos:migrate OK -> ${database} (schema dbos, role wiki_writer)`);
