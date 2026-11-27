/**
 * `pnpm smoke:t2` — ENG-T2 §6 Gate 9 end to end, offline (AI_MODE=replay, zero API keys):
 *   1. compose stack up (--wait)            2. dbmate migrations + DBOS system schema
 *   3. import-golden (CLI) for both golden fixtures from PROMETHEUS_VAULT_DIR
 *   4. verify the 8 primary Slice Cards in Valkey (<= 350 tokens, < 5 ms reads)
 *   5. start apps/core (dist) and POST /api/v1/dev/match for Profiles 1-3 with the ruled params + asOf
 *   6. one replay WF-03 verification cycle through the `verify-target` CLI (DBOS + cassettes)
 * Exits 0 only when every step passes. Runs the built `dist/` entry points exactly as production would.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCacheConfig, loadWikiCuratorConfig } from '@prometheus/config';
import { MatchResult, SliceCard } from '@prometheus/contracts';
import { ValkeyCacheAdapter } from '@prometheus/infra-adapters/local';
import { openRuntime, openWikiServices } from '../../apps/wiki-curator/src/bootstrap.js';
import { SCENARIOS } from '../../apps/wiki-curator/test/support/curator-scenarios.js';
import {
  seedScenarioContext,
  seedScenarioSnapshot,
} from '../../apps/wiki-curator/test/support/scenario-seed.js';
import { GOLDEN_FILES, gate7Violations, goldenPath, loadGate7Profiles } from './test/support/golden.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = `${ROOT}apps/wiki-curator/dist/cli.js`;
const CORE = `${ROOT}apps/core/dist/server.js`;
const PORT = process.env['CORE_HTTP_PORT'] ?? '8787';
const SEASON = '2027-FALL';

class StepFailed extends Error {
  override readonly name = 'StepFailed';
}

const log = (line: string): void => console.log(`[smoke:t2] ${line}`);

async function step<T>(n: number, name: string, work: () => Promise<T> | T): Promise<T> {
  const started = performance.now();
  try {
    const value = await work();
    log(`STEP ${n} ${name}: OK (${Math.round(performance.now() - started)} ms)`);
    return value;
  } catch (error) {
    log(`STEP ${n} ${name}: FAILED - ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

function run(command: string, args: readonly string[]): string {
  const res = spawnSync(command, [...args], {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0)
    throw new StepFailed(
      `${[command, ...args].join(' ')} exited ${res.status}: ${(res.stderr || res.stdout).slice(-2_000)}`,
    );
  return res.stdout;
}

/** Last JSON line printed by a CLI command. */
function lastJson(stdout: string): Record<string, unknown> {
  const line = stdout
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.startsWith('{'))
    .at(-1);
  if (line === undefined) throw new StepFailed(`no JSON output: ${stdout.slice(-500)}`);
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null) throw new StepFailed('CLI output is not an object');
  return { ...parsed };
}

async function waitForHealth(url: string, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (child.exitCode !== null) throw new StepFailed(`core exited early (code ${child.exitCode})`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new StepFailed('core did not become healthy within 10 s');
}

async function main(): Promise<void> {
  await step(1, 'compose stack up', () =>
    run('docker', ['compose', '-f', 'deploy/compose/compose.yaml', 'up', '-d', '--wait']),
  );
  await step(2, 'migrations (dbmate + DBOS schema)', () =>
    run(process.execPath, ['scripts/db.mjs', 'migrate']),
  );

  await step(3, 'import-golden x 2', () => {
    for (const file of GOLDEN_FILES) {
      const out = lastJson(run(process.execPath, [CLI, 'import-golden', '--file', goldenPath(file)]));
      const nodes = Array.isArray(out['nodes']) ? out['nodes'] : [];
      log(`  ${file}: ${nodes.length} nodes, ${Array.isArray(out['cards']) ? out['cards'].length : 0} cards`);
    }
  });

  await step(4, 'Valkey Slice Cards (8 primary, <= 350 tokens, < 5 ms)', async () => {
    const valkey = new ValkeyCacheAdapter(loadCacheConfig(process.env).valkeyUrl);
    try {
      // open the (lazy) connection first: the gate measures card reads, not TCP connection setup
      await valkey.get('wiki:card:warmup');
      const wanted: Array<[string, string]> = [
        ['docs', 'polimi:msc-cse'],
        ['tuition_aid', 'polimi'],
        ['city', 'IT-MILAN'],
        ['dorms', 'polimi'],
        ['docs', 'wut:bsc-cs-networks'],
        ['tuition_aid', 'wut'],
        ['city', 'PL-WARSAW'],
        ['dorms', 'wut'],
      ];
      // LOW-7: p95 over 20 reads per card
      for (const [kind, id] of wanted) {
        const key = `wiki:card:${kind}:${id}:${SEASON}`;
        const samples: number[] = [];
        let raw: string | undefined;
        for (let i = 0; i < 20; i += 1) {
          const t = performance.now();
          raw = await valkey.get(key);
          samples.push(performance.now() - t);
        }
        if (raw === undefined) throw new StepFailed(`missing ${key}`);
        const card = SliceCard.parse(JSON.parse(raw));
        samples.sort((a, b) => a - b);
        const p95 = samples[Math.floor(samples.length * 0.95)] ?? Infinity;
        if (card.est_tokens > 350 || p95 >= 5)
          throw new StepFailed(`${key}: ${card.est_tokens} tokens, p95 ${p95.toFixed(2)} ms`);
        log(`  ${key}: ${card.est_tokens} tokens, p95 ${p95.toFixed(2)} ms over 20 reads`);
      }
    } finally {
      await valkey.close();
    }
  });

  await step(5, 'POST /api/v1/dev/match Profiles 1-3 (as app_core, $0)', async () => {
    const core = spawn(process.execPath, [CORE], {
      cwd: ROOT,
      env: { ...process.env, CORE_HTTP_PORT: PORT },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await waitForHealth(`http://127.0.0.1:${PORT}/healthz`, core);
      for (const p of loadGate7Profiles()) {
        const res = await fetch(`http://127.0.0.1:${PORT}/api/v1/dev/match`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: p.input, asOf: p.asOf }),
        });
        if (res.status !== 200) throw new StepFailed(`${p.id}: HTTP ${res.status} ${await res.text()}`);
        const result = MatchResult.parse(await res.json());
        const violations = gate7Violations(p.id, result);
        if (violations.length > 0 || result.llmCostUsd !== 0)
          throw new StepFailed(`${p.id}: ${violations.join('; ')} (llmCostUsd ${result.llmCostUsd})`);
        const top = result.matches
          .slice(0, 3)
          .map((m) => `${m.programId}=${m.fitTier}[${m.flags.map((f) => f.code).join(',')}]`);
        log(
          `  ${p.id}: ${result.matches.length} matches, ${result.excluded.length} excluded, $${result.llmCostUsd}; ${top.join(' | ')}`,
        );
      }
    } finally {
      core.kill('SIGTERM');
    }
  });

  await step(6, 'replay WF-03 cycle (verify-target via DBOS + cassettes)', async () => {
    const runtime = await openRuntime(loadWikiCuratorConfig(process.env));
    const services = openWikiServices(runtime, loadCacheConfig(process.env));
    try {
      await seedScenarioContext(runtime, services);
      await seedScenarioSnapshot(runtime, SCENARIOS.good);
    } finally {
      await services.close();
      await runtime.close();
    }
    const out = lastJson(run(process.execPath, [CLI, 'verify-target', '--target', SCENARIOS.good.targetKey]));
    if (out['status'] !== 'DEEP_VERIFIED') throw new StepFailed(`WF-03 status ${String(out['status'])}`);
    log(
      `  ${String(out['workflowId'])}: ${String(out['status'])} v${String(out['version'])}, agentA ${JSON.stringify(out['agentA'])}, agentB ${JSON.stringify(out['agentB'])}, cards ${String(out['cards'])}`,
    );
  });

  log('SMOKE T2 PASSED');
}

main().catch(() => {
  log('SMOKE T2 FAILED');
  process.exitCode = 1;
});
