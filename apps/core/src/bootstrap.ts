import type { AiConfig, CoreConfig } from '@prometheus/config';
import { buildAdapters, KyselyEconomics, ModelRouter } from '@prometheus/ai';
import { connectAs, type Database } from '@prometheus/db';
import { FileSecretsAdapter } from '@prometheus/infra-adapters/local';
import { createUuidV7Generator, systemClock, type ClockPort } from '@prometheus/kernel';
import {
  KyselyMatchCatalog,
  MatchService,
  RouterQueryEmbedder,
  RouterTriage,
  SqlSimilarity,
  type ProgramListingPort,
} from './modules/matching/index.js';

/**
 * Composition root of apps/core (the only place adapters are chosen). The core connects EXCLUSIVELY as
 * `app_core`: `connectAs` verifies `current_user`, and app_core holds SELECT-only access to `wiki.*` through
 * `wiki_reader`. It never imports wiki-curator code or a write-role adapter (dependency-cruiser enforced).
 */
export interface CoreRuntime {
  readonly db: Database;
  readonly matching: MatchService;
  readonly programs: ProgramListingPort;
  readonly clock: ClockPort;
  close(): Promise<void>;
}

export async function openCoreRuntime(config: CoreConfig, ai: AiConfig): Promise<CoreRuntime> {
  const secrets = new FileSecretsAdapter(config.secretsDir);
  const db = await connectAs('app_core', {
    ...config.postgres,
    password: await secrets.getSecret('app_core_db_password'),
    applicationName: 'core',
  });
  const clock = systemClock;
  const router = new ModelRouter({
    adapters: await buildAdapters(ai, secrets),
    economics: new KyselyEconomics(db, createUuidV7Generator(clock)),
  });
  const catalog = new KyselyMatchCatalog(db);
  const matching = new MatchService({
    catalog,
    similarity: new SqlSimilarity(db),
    embedder: config.embeddings ? new RouterQueryEmbedder(router) : undefined,
    triage: new RouterTriage(router),
    clock,
  });
  return { db, matching, programs: catalog, clock, close: () => db.destroy() };
}
