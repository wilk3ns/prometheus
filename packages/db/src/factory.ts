import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';
import type { DB } from './generated/db.js';

/** Database roles the application tier may connect as (migrator/superuser is repo tooling only). */
export type DbRole = 'wiki_writer' | 'app_core';

export interface DbConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly password: string;
  readonly maxConnections?: number;
  readonly applicationName?: string;
}

export type Database = Kysely<DB>;

export class DbRoleMismatchError extends Error {
  override readonly name = 'DbRoleMismatchError';
  constructor(
    readonly expected: DbRole,
    readonly actual: string,
  ) {
    super(`Connected as '${actual}' but this process may only run as '${expected}'`);
  }
}

/**
 * Creates a Kysely instance that logs in as exactly `role` and verifies it (`current_user`) before
 * returning, so a mis-wired credential can never silently run with broader privileges.
 */
export async function connectAs(role: DbRole, options: DbConnectionOptions): Promise<Database> {
  const pool = new pg.Pool({
    host: options.host,
    port: options.port,
    database: options.database,
    user: role,
    password: options.password,
    max: options.maxConnections ?? 5,
    application_name: options.applicationName ?? `prometheus-${role}`,
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  try {
    const { rows } = await sql<{ current_user: string }>`SELECT current_user`.execute(db);
    const actual = rows[0]?.current_user ?? '<unknown>';
    if (actual !== role) throw new DbRoleMismatchError(role, actual);
    return db;
  } catch (error) {
    await db.destroy();
    throw error;
  }
}
