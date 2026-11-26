// Vitest globalSetup for the `it` project: fresh, fully migrated `<PG_DATABASE>_it` database per run.
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, applyLocalDefaults } from './env.mjs';

export default function setup() {
  applyLocalDefaults();
  const itDb = process.env.PG_DATABASE.endsWith('_it')
    ? process.env.PG_DATABASE
    : `${process.env.PG_DATABASE}_it`;
  process.env.PG_DATABASE = itDb;
  const res = spawnSync(process.execPath, [`${REPO_ROOT}scripts/db.mjs`, 'reset'], {
    stdio: 'inherit',
    env: process.env,
  });
  if (res.status !== 0)
    throw new Error('integration DB reset failed - is the compose stack up (`pnpm stack:up`)?');
}
