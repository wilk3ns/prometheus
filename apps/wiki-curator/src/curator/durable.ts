import { DBOS } from '@dbos-inc/dbos-sdk';

/**
 * DBOS Transact lifecycle for the curator (ENG-01 §1 durable workflows, ENG-T2 §4). The system schema `dbos`
 * is provisioned by the migrator role (scripts/dbos-migrate.mjs); this process connects as `wiki_writer`
 * with `runMigrations: false`, so the runtime role never runs DDL.
 * Workflows must be registered (workflows.ts) BEFORE `launchDurable`.
 */
export const DBOS_APPLICATION_VERSION = 'wf-epoch-1';

export interface DurableOptions {
  /** postgres:// URL authenticating as `wiki_writer` (credential from SecretsPort). */
  readonly systemDatabaseUrl: string;
}

export async function launchDurable(options: DurableOptions): Promise<void> {
  DBOS.setConfig({
    name: 'prometheus-wiki-curator',
    systemDatabaseUrl: options.systemDatabaseUrl,
    systemDatabaseSchemaName: 'dbos',
    applicationVersion: DBOS_APPLICATION_VERSION,
    runMigrations: false,
    logLevel: 'warn',
  });
  await DBOS.launch();
}

export async function shutdownDurable(): Promise<void> {
  await DBOS.shutdown({ deregister: true });
}
