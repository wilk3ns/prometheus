import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadWikiCuratorConfig } from '@prometheus/config';
import type { CrawlReport, UrlCrawlOutcome } from '@prometheus/contracts';
import { openCrawlSession, openRuntime, type CuratorRuntime } from '../bootstrap.js';
import { applySeed, parseSeed, readSeedFile } from '../seed/seed.js';

/**
 * T1 Exit Gate 8 (`pnpm smoke:t1`): seeds the vault's 5-country seed file plus a local fixture target,
 * crawls fixture-sites twice and proves content-addressed dedupe on the second run (raw_blob_ref reused,
 * 0 new MinIO objects). With LIVE_CRAWL=1 it also snapshots a bounded slice of one live official target
 * (informational, never a gate). Requires: compose stack up, `pnpm db:migrate`, local secrets,
 * PROMETHEUS_VAULT_DIR, and ALLOW_LOCAL_FIXTURE_HOSTS=true (set by the package script).
 */

const VAULT_SEED = join('engineering', 'fixtures', 'seed-5country-targets.json');
const FIXTURE_TARGET = 'fixture:hub-smoke:2027-FALL';
const LIVE_TARGET = 'polimi:msc-cse:2027-FALL';

class SmokeFailure extends Error {
  override readonly name = 'SmokeFailure';
}

let checks = 0;
function check(condition: boolean, label: string): void {
  checks += 1;
  if (!condition) throw new SmokeFailure(`CHECK FAILED: ${label}`);
  console.log(`  ok  ${label}`);
}

function byPath(report: CrawlReport, origin: string, path: string): UrlCrawlOutcome {
  const o = report.outcomes.find((x) => x.url === `${origin}${path}`);
  if (!o) throw new SmokeFailure(`no outcome for ${path}`);
  return o;
}

async function blobCounts(runtime: CuratorRuntime): Promise<{ raw: number; text: number }> {
  return {
    raw: (await runtime.blobs.listKeys('raw/')).length,
    text: (await runtime.blobs.listKeys('text/')).length,
  };
}

function summarize(report: CrawlReport): string {
  const tally = new Map<string, number>();
  for (const o of report.outcomes) {
    const key =
      o.status === 'SNAPSHOT_STORED'
        ? `${o.fetchTier}/${o.contentKind}`
        : o.status === 'SNAPSHOT_ERROR_RECORDED'
          ? o.errorCode
          : `NOT_FETCHED:${o.reason}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return `${report.targetKey}: fetched=${report.fetchedCount} ${[...tally].map(([k, v]) => `${k}=${v}`).join(' ')}`;
}

async function main(): Promise<void> {
  const config = loadWikiCuratorConfig(process.env);
  if (!config.crawler.allowLocalFixtureHosts) {
    throw new SmokeFailure(
      'smoke:t1 crawls the local fixture site: ALLOW_LOCAL_FIXTURE_HOSTS=true is required',
    );
  }
  if (config.vaultDir === undefined) {
    throw new SmokeFailure('PROMETHEUS_VAULT_DIR must be set to the absolute path of the Prometheus vault');
  }
  const seedPath = join(config.vaultDir, VAULT_SEED);
  if (!existsSync(seedPath)) throw new SmokeFailure(`vault seed file not found: ${seedPath}`);
  const origin = new URL(process.env['FIXTURE_SITES_ORIGIN'] ?? '').origin;

  const runtime = await openRuntime(config);
  try {
    console.log(`[1/5] seed ${seedPath}`);
    const vaultSeed = await readSeedFile(seedPath);
    const vaultResult = await applySeed(runtime.repo, vaultSeed, runtime.ids);
    console.log(
      `      upserted allowlist=${vaultResult.allowlistUpserted} targets=${vaultResult.targetsUpserted}`,
    );
    const again = await applySeed(runtime.repo, vaultSeed, runtime.ids);
    const targets = await runtime.repo.listActiveTargets();
    check(
      again.targetsUpserted === vaultResult.targetsUpserted,
      'vault seed is idempotent (re-run upserts in place)',
    );
    check(
      vaultSeed.crawl_targets.every((t) => targets.some((r) => r.targetKey === t.target_key)),
      `all ${vaultSeed.crawl_targets.length} vault crawl targets present in wiki.crawl_target`,
    );

    console.log(`[2/5] seed local fixture target ${FIXTURE_TARGET} (${origin})`);
    await applySeed(
      runtime.repo,
      parseSeed({
        schema_version: 'seed-targets-v1.0',
        allowlisted_domains: [
          {
            host: new URL(origin).hostname,
            country_iso2: 'PL',
            org_kind: 'UNIVERSITY',
            allow_subdomains: false,
            default_fetch_mode: 'HTTP_FIRST',
            notes: 'LOCAL FIXTURE (smoke:t1) - unreachable outside ALLOW_LOCAL_FIXTURE_HOSTS=true',
          },
        ],
        crawl_targets: [
          {
            target_key: FIXTURE_TARGET,
            country_iso2: 'PL',
            layer_hint: 'PROGRAM',
            max_depth: 1,
            max_pages: 30,
            seed_urls: ['/hub', '/js-catalog', '/sample.pdf', '/waf-blocked'].map((p) => `${origin}${p}`),
          },
        ],
      }),
      runtime.ids,
    );
    const fixture = await runtime.repo.findTargetByKey(FIXTURE_TARGET);
    if (!fixture) throw new SmokeFailure('fixture target missing after seed');

    const session = await openCrawlSession(runtime);
    try {
      console.log('[3/5] crawl #1');
      const before = await blobCounts(runtime);
      const run1 = await session.runner.crawl(fixture);
      const afterRun1 = await blobCounts(runtime);
      console.log(`      ${summarize(run1)}`);
      const hub = byPath(run1, origin, '/hub');
      check(hub.status === 'SNAPSHOT_STORED' && hub.fetchTier === 'TIER1_HTTP', '/hub via TIER1_HTTP');
      const js = byPath(run1, origin, '/js-catalog');
      check(
        js.status === 'SNAPSHOT_STORED' && js.fetchTier === 'TIER2_PLAYWRIGHT' && js.cleanCharCount > 1000,
        '/js-catalog escalated to TIER2_PLAYWRIGHT with > 1,000 chars',
      );
      const pdf = byPath(run1, origin, '/sample.pdf');
      check(
        pdf.status === 'SNAPSHOT_STORED' && pdf.contentKind === 'PDF' && pdf.fetchTier === 'TIER1_HTTP',
        '/sample.pdf stored as PDF via TIER1_HTTP',
      );
      const waf = byPath(run1, origin, '/waf-blocked');
      check(
        waf.status === 'SNAPSHOT_ERROR_RECORDED' && waf.errorCode === 'WAF_CHALLENGE_DETECTED',
        '/waf-blocked -> WAF_CHALLENGE_DETECTED',
      );
      const gone = byPath(run1, origin, '/broken-404');
      check(
        gone.status === 'SNAPSHOT_ERROR_RECORDED' && gone.errorCode === 'MISSING_SOURCE_404',
        '/broken-404 -> MISSING_SOURCE_404',
      );
      const off = byPath(run1, origin, '/offsite');
      check(
        off.status === 'SNAPSHOT_ERROR_RECORDED' && off.errorCode === 'DISALLOWED_REDIRECT',
        '/offsite -> DISALLOWED_REDIRECT',
      );
      check(
        byPath(run1, origin, '/pl/cennik-ds').status === 'SNAPSHOT_STORED',
        'local-language /pl/cennik-ds followed and stored',
      );
      console.log(`      blobs raw ${before.raw}->${afterRun1.raw}, text ${before.text}->${afterRun1.text}`);

      console.log('[4/5] crawl #2 (content-addressed dedupe)');
      const run2 = await session.runner.crawl(fixture);
      const afterRun2 = await blobCounts(runtime);
      console.log(`      ${summarize(run2)}`);
      const stored1 = run1.outcomes.filter((o) => o.status === 'SNAPSHOT_STORED');
      const stored2 = run2.outcomes.filter((o) => o.status === 'SNAPSHOT_STORED');
      check(
        stored2.length === stored1.length && stored2.length > 0,
        `run #2 stored the same ${stored1.length} documents`,
      );
      check(
        stored2.every((o) => !o.rawBlobCreated && !o.textBlobCreated),
        'run #2 uploaded 0 new raw/text blobs (put-if-absent hit for every document)',
      );
      check(
        stored2.every((o) => stored1.some((p) => p.url === o.url && p.rawBlobRef === o.rawBlobRef)),
        'run #2 raw_blob_ref identical to run #1 for every URL',
      );
      check(
        afterRun2.raw === afterRun1.raw && afterRun2.text === afterRun1.text,
        `MinIO object count unchanged after run #2 (raw=${afterRun2.raw}, text=${afterRun2.text}): 0 duplicate blobs`,
      );
      check(
        new Set(stored2.map((o) => o.snapshotId)).size === stored2.length &&
          stored2.every((o) => !stored1.some((p) => p.snapshotId === o.snapshotId)),
        'run #2 still recorded fresh timestamped wiki.source_snapshot rows',
      );

      if (config.liveCrawl) {
        console.log(
          `[5/5] LIVE_CRAWL=1: bounded live crawl of ${LIVE_TARGET} (3 pages, depth 0; informational)`,
        );
        const live = await runtime.repo.findTargetByKey(LIVE_TARGET);
        if (!live) throw new SmokeFailure(`live target ${LIVE_TARGET} not seeded`);
        const liveReport = await session.runner.crawl({ ...live, maxDepth: 0, maxPages: 3 });
        console.log(`      ${summarize(liveReport)}`);
        for (const o of liveReport.outcomes) {
          const detail =
            o.status === 'SNAPSHOT_STORED'
              ? `${o.fetchTier} ${o.contentKind} chars=${o.cleanCharCount}`
              : o.status === 'SNAPSHOT_ERROR_RECORDED'
                ? `${o.errorCode} http=${o.httpStatus}`
                : `${o.reason} ${o.detail}`;
          console.log(`      - ${o.url} -> ${o.status} ${detail}`);
        }
      } else {
        console.log('[5/5] live crawl skipped (set LIVE_CRAWL=1 to snapshot one live official target)');
      }
    } finally {
      await session.close();
    }
  } finally {
    await runtime.close();
  }
  console.log(`smoke:t1 PASSED (${checks} checks)`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
  process.exitCode = 1;
});
