#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadWikiCuratorConfig } from '@prometheus/config';
import { openCrawlSession, openRuntime } from './bootstrap.js';
import { runCrawlBatch } from './ops/crawl-batch.js';
import { applySeed, readSeedFile } from './seed/seed.js';

const USAGE = `usage:
  wiki-curator seed  --file <absolute path to seed-targets-v1.0 JSON>
  wiki-curator crawl --target <target_key> | --all`;

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

  throw new UsageError(`unknown command ${command ?? ''}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof UsageError) console.error(`${error.message}\n${USAGE}`);
  else console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
