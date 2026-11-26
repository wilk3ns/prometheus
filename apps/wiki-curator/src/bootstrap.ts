import type { WikiCuratorConfig } from '@prometheus/config';
import { connectAs, type Database } from '@prometheus/db';
import { FileSecretsAdapter, S3BlobStoreAdapter } from '@prometheus/infra-adapters/local';
import type { BlobStorePort } from '@prometheus/infra-ports';
import { createUuidV7Generator, systemClock, type ClockPort, type IdGen } from '@prometheus/kernel';
import { DomainAllowlist } from './crawler/allowlist.js';
import { CrawlRunner } from './crawler/crawl-runner.js';
import { KeywordLinkSelector } from './crawler/link-selector.js';
import { PdfjsTextExtractor } from './crawler/pdf-extractor.js';
import { RequestGuard } from './crawler/request-guard.js';
import { SnapshotStore } from './crawler/snapshot-store.js';
import { UndiciHttpFetcher } from './crawler/tier1-http.js';
import { PlaywrightJsRenderer } from './crawler/tier2-playwright.js';
import { KyselyWikiRepository } from './persistence/kysely-wiki-repository.js';
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
    async close() {
      blobs.destroy();
      await db.destroy();
    },
  };
}

export interface CrawlSession {
  readonly runner: CrawlRunner;
  readonly allowlist: DomainAllowlist;
  close(): Promise<void>;
}

/** Builds a crawl session against the allowlist as currently stored in `wiki.official_domain_allowlist`. */
export async function openCrawlSession(runtime: CuratorRuntime): Promise<CrawlSession> {
  const allowlist = new DomainAllowlist(await runtime.repo.loadAllowlist());
  const guard = new RequestGuard(allowlist, {
    allowNonPublic: runtime.config.crawler.allowLocalFixtureHosts,
  });
  const options = { userAgent: runtime.config.crawler.userAgent };
  const http = new UndiciHttpFetcher(guard, options);
  const renderer = new PlaywrightJsRenderer(guard, options);
  const runner = new CrawlRunner({
    capture: { allowlist, http, renderer, pdf: new PdfjsTextExtractor() },
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
      await http.close();
    },
  };
}
