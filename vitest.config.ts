import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { applyLocalDefaults } from './scripts/env.mjs';

const src = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

// Workspace packages resolve to their TypeScript sources in tests (no build step needed). Explicit aliases
// keep third-party resolution untouched (custom export conditions break CJS deps such as `pg`).
const workspaceSources = {
  resolve: {
    alias: {
      '@prometheus/kernel': src('./packages/kernel/src/index.ts'),
      '@prometheus/config': src('./packages/config/src/index.ts'),
      '@prometheus/contracts': src('./packages/contracts/src/index.ts'),
      '@prometheus/infra-ports': src('./packages/infra-ports/src/index.ts'),
      '@prometheus/infra-adapters/local': src('./packages/infra-adapters/local/index.ts'),
      '@prometheus/infra-adapters/azure': src('./packages/infra-adapters/azure/index.ts'),
      '@prometheus/db': src('./packages/db/src/index.ts'),
      '@prometheus/ai': src('./packages/ai/src/index.ts'),
    },
  },
};

function itEnv(): Record<string, string> {
  const env: Record<string, string | undefined> = applyLocalDefaults({ ...process.env });
  const db = env['PG_DATABASE'] ?? 'prometheus';
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return { ...out, PG_DATABASE: db.endsWith('_it') ? db : `${db}_it`, ALLOW_LOCAL_FIXTURE_HOSTS: 'true' };
}

export default defineConfig({
  test: {
    projects: [
      {
        ...workspaceSources,
        test: {
          name: 'unit',
          include: ['{packages,apps}/**/test/**/*.test.ts'],
          exclude: ['**/*.golden.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        ...workspaceSources,
        test: {
          name: 'it',
          include: ['{packages,apps}/**/test/**/*.it.ts'],
          exclude: ['**/*.golden.it.ts', '**/node_modules/**'],
          environment: 'node',
          globalSetup: ['./scripts/it-global-setup.mjs'],
          env: itEnv(),
          // ITs share one database, bucket and fixture server; run files sequentially for determinism.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
      {
        // Golden-record gates (6, 7, 9): need PROMETHEUS_VAULT_DIR (fixtures live only in the vault) and the stack.
        ...workspaceSources,
        test: {
          name: 'golden',
          // ENG-T2 §6 file names (matching-golden.it.ts) + golden unit tests; the vault is required for all of them
          include: ['tests/e2e/test/**/*.{golden.test,it}.ts'],
          environment: 'node',
          globalSetup: ['./scripts/it-global-setup.mjs'],
          env: itEnv(),
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
