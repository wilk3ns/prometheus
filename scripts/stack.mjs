// `docker compose` wrapper for the local stack. Port overrides (PG_PORT, VALKEY_PORT, MINIO_PORT,
// MINIO_CONSOLE_PORT, FIXTURE_SITES_PORT) are read from the calling environment by compose itself.
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './env.mjs';

const args = ['compose', '-f', `${REPO_ROOT}deploy/compose/compose.yaml`];
const action = process.argv[2];
if (action === 'up') args.push('up', '-d', '--wait');
else if (action === 'down') args.push('down');
else {
  console.error('usage: node scripts/stack.mjs <up|down>');
  process.exit(2);
}
const res = spawnSync('docker', args, { stdio: 'inherit' });
process.exit(res.status ?? 1);
