#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';
import { AdmissionSeason } from '@prometheus/contracts';
import { loadAiConfig, loadCacheConfig, loadWikiCuratorConfig } from '@prometheus/config';
import {
  openCrawlSession,
  openDurableCurator,
  openModelRouter,
  openRuntime,
  openWikiServices,
  type CuratorRuntime,
} from './bootstrap.js';
import { importGolden, readGoldenPlan } from './curator/golden-importer.js';
import { layerForHint } from './curator/layers.js';
import type { BaselineTargetSpec } from './curator/workflows.js';
import { runCrawlBatch } from './ops/crawl-batch.js';
import { applySeed, readSeedFile } from './seed/seed.js';

const USAGE = `usage:
  wiki-curator seed           --file <absolute path to seed-targets-v1.0 JSON>
  wiki-curator crawl          --target <target_key> | --all
  wiki-curator import-golden  --file <absolute path to a wiki-v2.0 golden JSON>
  wiki-curator verify-target  --target <target_key> [--node-key <key>] [--season <YYYY-FALL>]
  wiki-curator build-baseline --season <YYYY-FALL> --batch <id> (--target <target_key> | --all)`;

class UsageError extends Error {
  override readonly name = 'UsageError';
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: [...rest],
    options: {
      file: { type: 'string' },
      target: { type: 'string' },
      all: { type: 'boolean', default: false },
      season: { type: 'string' },
      batch: { type: 'string' },
      'node-key': { type: 'string' },
    },
    strict: true,
  });

  if (command === 'seed') {
    if (!values.file) throw new UsageError('seed requires --file');
    const config = loadWikiCuratorConfig(process.env);
    // validate (same port policy as the crawler) before touching the database
    const seed = await readSeedFile(values.file, {
      nonDefaultPortHosts: new Set(config.crawler.localFixtureHosts),
    });
    const runtime = await openRuntime(config);
    try {
      const result = await applySeed(runtime.repo, seed, runtime.ids);
      console.log(JSON.stringify({ command: 'seed', file: values.file, ...result }));
    } finally {
      await runtime.close();
    }
    return;
  }

  if (command === 'crawl') {
    if (!values.target === !values.all)
      throw new UsageError('crawl requires exactly one of --target or --all');
    const runtime = await openRuntime(loadWikiCuratorConfig(process.env));
    const session = await openCrawlSession(runtime);
    try {
      let targets;
      if (values.target) {
        const one = await runtime.repo.findTargetByKey(values.target);
        if (!one) throw new UsageError(`unknown target_key ${values.target}`);
        targets = [one];
      } else {
        targets = await runtime.repo.listActiveTargets();
      }
      const summary = await runCrawlBatch(
        targets,
        (t) => session.runner.crawl(t),
        (line) => console.log(JSON.stringify(line)),
      );
      console.log(JSON.stringify({ command: 'crawl', ...summary }));
      if (summary.failed > 0) process.exitCode = 1;
    } finally {
      await session.close();
      await runtime.close();
    }
    return;
  }

  if (command === 'import-golden') {
    if (!values.file || !isAbsolute(values.file))
      throw new UsageError('import-golden requires an absolute --file');
    // map + validate (and fail on any TODO_RULING) before opening a single connection
    const plan = await readGoldenPlan(values.file);
    await withWiki(async (runtime, services) => {
      const result = await importGolden({ ...services, clock: runtime.clock }, plan);
      console.log(
        JSON.stringify({
          command: 'import-golden',
          file: result.file,
          compiledKey: result.compiledKey,
          nodes: result.nodes,
          cards: result.cards.map((c) => ({ kind: c.kind, nodeId: c.node_id, estTokens: c.est_tokens })),
          lockConflicts: result.lockConflicts,
        }),
      );
    });
    return;
  }

  if (command === 'verify-target') {
    if (!values.target) throw new UsageError('verify-target requires --target');
    const targetKey = values.target;
    await withWiki(async (runtime, services) => {
      const target = await runtime.repo.findTargetByKey(targetKey);
      if (!target) throw new UsageError(`unknown target_key ${targetKey}`);
      const layer = layerForHint(target.layerHint);
      // HIGH-2: the node is bound to the target (PROGRAM: its key) or named by ops (--node-key); never by a model
      const nodeKey = bindNodeKey(layer, targetKey, values['node-key']);
      const season = AdmissionSeason.parse(values.season ?? nodeKey.slice(nodeKey.lastIndexOf(':') + 1));
      const router = await openModelRouter(runtime, loadAiConfig(process.env));
      const durable = await openDurableCurator(runtime, services, router);
      try {
        const existing = await services.layers.findNode(layer, nodeKey);
        const result = await durable.workflows.verify(
          { layer, nodeKey, season, targetKey, countryIso2: target.countryIso2 },
          existing?.version ?? 0,
        );
        console.log(JSON.stringify({ command: 'verify-target', ...result, cards: result.cards.length }));
        if (result.status === 'ABORTED') process.exitCode = 1;
      } finally {
        await durable.close();
      }
    });
    return;
  }

  if (command === 'build-baseline') {
    if (!values.season || !values.batch) throw new UsageError('build-baseline requires --season and --batch');
    if (!values.target === !values.all)
      throw new UsageError('build-baseline requires exactly one of --target or --all');
    const season = AdmissionSeason.parse(values.season);
    const batch = values.batch;
    await withWiki(async (runtime, services) => {
      const rows = values.target
        ? [await runtime.repo.findTargetByKey(values.target)].filter((t) => t !== undefined)
        : await runtime.repo.listActiveTargets();
      if (rows.length === 0) throw new UsageError('no crawl targets selected');
      const specs: BaselineTargetSpec[] = rows.map((t) => {
        const layer = layerForHint(t.layerHint);
        // a single explicit target may carry an ops-supplied --node-key; unbound targets are skipped by WF-19
        const opsKey = values.target === undefined ? undefined : values['node-key'];
        const nodeKey =
          layer === 'PROGRAM_SPEC' || opsKey !== undefined ? bindNodeKey(layer, t.targetKey, opsKey) : null;
        return { targetKey: t.targetKey, layer, nodeKey, countryIso2: t.countryIso2 };
      });
      const router = await openModelRouter(runtime, loadAiConfig(process.env));
      const durable = await openDurableCurator(runtime, services, router);
      try {
        const result = await durable.workflows.baseline(season, batch, specs);
        console.log(JSON.stringify({ command: 'build-baseline', ...result }));
        if (result.targets.some((t) => t.status === 'ABORTED')) process.exitCode = 1;
      } finally {
        await durable.close();
      }
    });
    return;
  }

  throw new UsageError(`unknown command ${command ?? ''}`);
}

/** PROGRAM targets are keyed like their node; other layers need an ops-supplied key. */
function bindNodeKey(layer: string, targetKey: string, opsKey: string | undefined): string {
  if (layer === 'PROGRAM_SPEC') {
    if (opsKey !== undefined && opsKey !== targetKey) {
      throw new UsageError(`PROGRAM targets are bound to their own key ${targetKey}`);
    }
    return targetKey;
  }
  if (opsKey === undefined) throw new UsageError(`${layer} targets need an ops-supplied --node-key`);
  return opsKey;
}

async function withWiki(
  work: (runtime: CuratorRuntime, services: ReturnType<typeof openWikiServices>) => Promise<void>,
): Promise<void> {
  const runtime = await openRuntime(loadWikiCuratorConfig(process.env));
  const services = openWikiServices(runtime, loadCacheConfig(process.env));
  try {
    await work(runtime, services);
  } finally {
    await services.close();
    await runtime.close();
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) console.error(`${error.message}\n${USAGE}`);
  else console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
