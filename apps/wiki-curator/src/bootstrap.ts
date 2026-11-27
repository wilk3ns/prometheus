import type { AiConfig, CacheConfig, WikiCuratorConfig } from '@prometheus/config';
import { buildAdapters, KyselyEconomics, ModelRouter } from '@prometheus/ai';
import { connectAs, type Database } from '@prometheus/db';
import { FileSecretsAdapter, S3BlobStoreAdapter, ValkeyCacheAdapter } from '@prometheus/infra-adapters/local';
import type { BlobStorePort, SecretsPort } from '@prometheus/infra-ports';
import { createUuidV7Generator, systemClock, type ClockPort, type IdGen } from '@prometheus/kernel';
import { DomainAllowlist } from './crawler/allowlist.js';
import { GuardedHttpClient } from './crawler/guarded-http.js';
import { CrawlRunner } from './crawler/crawl-runner.js';
import { KeywordLinkSelector } from './crawler/link-selector.js';
import { CrawlPoliteness, PoliteHttpFetcher, PoliteJsRenderer } from './crawler/politeness.js';
import {
  ExtractionSandbox,
  SandboxedHtmlExtractor,
  SandboxedPdfExtractor,
} from './crawler/extraction-sandbox.js';
import { RequestGuard } from './crawler/request-guard.js';
import { SnapshotStore } from './crawler/snapshot-store.js';
import { UndiciHttpFetcher } from './crawler/tier1-http.js';
import { PlaywrightJsRenderer } from './crawler/tier2-playwright.js';
import { Materializer, SliceCardCache } from './curator/materializer.js';
import { DualPassCurator } from './curator/pipeline.js';
import { launchDurable, shutdownDurable } from './curator/durable.js';
import { registerCuratorWorkflows, type CuratorWorkflows } from './curator/workflows.js';
import {
  KyselyWikiLayerRepository,
  KyselySnapshotReader,
} from './persistence/kysely-wiki-layer-repository.js';
import { KyselyWikiRepository } from './persistence/kysely-wiki-repository.js';
import type { WikiLayerRepository } from './persistence/wiki-layer-repository.js';
import type { WikiRepository } from './persistence/wiki-repository.js';

/** Composition root of the wiki-curator. The only place adapters are chosen. */

export class UnsupportedProfileError extends Error {
  override readonly name = 'UnsupportedProfileError';
}

export interface CuratorRuntime {
  readonly db: Database;
  readonly repo: WikiRepository;
  readonly blobs: BlobStorePort;
  readonly ids: IdGen;
  readonly clock: ClockPort;
  readonly config: WikiCuratorConfig;
  readonly secrets: SecretsPort;
  close(): Promise<void>;
}

export async function openRuntime(config: WikiCuratorConfig): Promise<CuratorRuntime> {
  if (config.profile !== 'local') {
    // The Azure composition (Key Vault SecretsPort + managed-identity Blob client) is delivered in T8.
    throw new UnsupportedProfileError('INFRA_PROFILE=azure is not composable before tranche T8');
  }
  const secrets = new FileSecretsAdapter(config.secretsDir);
  // The curator connects ONLY as wiki_writer; connectAs verifies current_user before returning.
  const db = await connectAs('wiki_writer', {
    ...config.postgres,
    password: await secrets.getSecret('wiki_writer_db_password'),
    applicationName: 'wiki-curator',
  });
  const blobs = new S3BlobStoreAdapter({
    ...config.s3,
    secretAccessKey: await secrets.getSecret('s3_secret_access_key'),
    bucket: config.snapshotBucket,
  });
  const clock = systemClock;
  return {
    db,
    repo: new KyselyWikiRepository(db),
    blobs,
    ids: createUuidV7Generator(clock),
    clock,
    config,
    secrets,
    async close() {
      blobs.destroy();
      await db.destroy();
    },
  };
}

/** Wiki-v2.0 services (layer repository, materializer, Valkey card cache) over an open runtime. */
export interface WikiServices {
  readonly layers: WikiLayerRepository;
  readonly materializer: Materializer;
  readonly cards: SliceCardCache;
  close(): Promise<void>;
}

export function openWikiServices(runtime: CuratorRuntime, cache: CacheConfig): WikiServices {
  const valkey = new ValkeyCacheAdapter(cache.valkeyUrl);
  return {
    layers: new KyselyWikiLayerRepository(runtime.db, runtime.ids),
    materializer: new Materializer(),
    cards: new SliceCardCache(valkey),
    close: () => valkey.close(),
  };
}

/** The cross-family ModelRouter (replay by default: zero keys), metering into `econ.*` as wiki_writer. */
export async function openModelRouter(runtime: CuratorRuntime, ai: AiConfig): Promise<ModelRouter> {
  const economics = new KyselyEconomics(runtime.db, runtime.ids);
  await economics.syncRateCard('2026-01-01');
  return new ModelRouter({ adapters: await buildAdapters(ai, runtime.secrets), economics });
}

export interface DurableCurator {
  readonly workflows: CuratorWorkflows;
  close(): Promise<void>;
}

/** Registers WF-03 / WF-19 and launches DBOS (system schema `dbos`, connecting as wiki_writer). */
export async function openDurableCurator(
  runtime: CuratorRuntime,
  services: WikiServices,
  router: ModelRouter,
): Promise<DurableCurator> {
  const allowlist = new DomainAllowlist(await runtime.repo.loadAllowlist(), {
    nonDefaultPortHosts: new Set(runtime.config.crawler.localFixtureHosts),
  });
  const curator = new DualPassCurator({
    router,
    layers: services.layers,
    snapshots: new KyselySnapshotReader(runtime.db, runtime.blobs),
    isAllowlisted: (url) => allowlist.allows(url),
    materializer: services.materializer,
    clock: runtime.clock,
    useModelLinkHealer: false,
  });
  const workflows = registerCuratorWorkflows(curator, services.cards);
  const pg = runtime.config.postgres;
  const password = encodeURIComponent(await runtime.secrets.getSecret('wiki_writer_db_password'));
  await launchDurable({
    systemDatabaseUrl: `postgres://wiki_writer:${password}@${pg.host}:${pg.port}/${pg.database}?sslmode=${pg.sslmode}`,
  });
  return { workflows, close: () => shutdownDurable() };
}

export interface CrawlSession {
  readonly runner: CrawlRunner;
  readonly allowlist: DomainAllowlist;
  close(): Promise<void>;
}

/** Builds a crawl session against the allowlist as currently stored in `wiki.official_domain_allowlist`. */
export async function openCrawlSession(runtime: CuratorRuntime): Promise<CrawlSession> {
  // The local fixture exemption (empty unless INFRA_PROFILE=local + ALLOW_LOCAL_FIXTURE_HOSTS=true) is
  // host-scoped: only these hostnames may resolve to non-public addresses or use non-default ports.
  const exempt: ReadonlySet<string> = new Set(runtime.config.crawler.localFixtureHosts);
  const allowlist = new DomainAllowlist(await runtime.repo.loadAllowlist(), { nonDefaultPortHosts: exempt });
  const guard = new RequestGuard(allowlist, { nonPublicAllowedHosts: exempt });
  const client = new GuardedHttpClient(guard, { userAgent: runtime.config.crawler.userAgent });
  const guardedHttp = new UndiciHttpFetcher(client);
  // Politeness (robots.txt + per-host token bucket) on every non-fixture host; robots.txt itself is
  // fetched through the same guarded Tier 1 fetcher (ENG-T2 §0 Q3).
  const politeness = new CrawlPoliteness({ robotsFetcher: guardedHttp, exemptHosts: exempt });
  const http = new PoliteHttpFetcher(guardedHttp, politeness);
  const playwright = new PlaywrightJsRenderer(client, runtime.config.crawler.userAgent);
  const renderer = new PoliteJsRenderer(playwright, politeness);
  // Extraction runs in terminable worker threads (hard wall-clock + heap limits).
  const sandbox = new ExtractionSandbox();
  const runner = new CrawlRunner({
    capture: {
      allowlist,
      http,
      renderer,
      pdf: new SandboxedPdfExtractor(sandbox),
      html: new SandboxedHtmlExtractor(sandbox, allowlist),
    },
    snapshots: new SnapshotStore(runtime.blobs, runtime.repo, runtime.ids, runtime.clock),
    selector: new KeywordLinkSelector(),
    repo: runtime.repo,
    clock: runtime.clock,
  });
  return {
    runner,
    allowlist,
    async close() {
      await renderer.close();
      await client.close();
    },
  };
}
