import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadWikiCuratorConfig } from '../src/index.js';

const abs = resolve(tmpdir(), 'prometheus-secrets');

const local = {
  INFRA_PROFILE: 'local',
  PG_HOST: 'localhost',
  PG_PORT: '5432',
  PG_DATABASE: 'prometheus',
  SECRETS_DIR: abs,
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'minio-dev',
};

describe('[T1-G1] config loader', () => {
  it('parses a minimal local profile with safe defaults', () => {
    const cfg = loadWikiCuratorConfig(local);
    expect(cfg.profile).toBe('local');
    expect(cfg.postgres.port).toBe(5432);
    expect(cfg.crawler.allowLocalFixtureHosts).toBe(false);
    expect(cfg.snapshotBucket).toBe('wiki-snapshots');
    expect(cfg.liveCrawl).toBe(false);
  });

  it('parses ALLOW_LOCAL_FIXTURE_HOSTS strictly (no truthy coercion)', () => {
    expect(
      loadWikiCuratorConfig({ ...local, ALLOW_LOCAL_FIXTURE_HOSTS: 'true' }).crawler.allowLocalFixtureHosts,
    ).toBe(true);
    expect(
      loadWikiCuratorConfig({ ...local, ALLOW_LOCAL_FIXTURE_HOSTS: 'false' }).crawler.allowLocalFixtureHosts,
    ).toBe(false);
    expect(() => loadWikiCuratorConfig({ ...local, ALLOW_LOCAL_FIXTURE_HOSTS: '1' })).toThrow(ConfigError);
  });

  it('rejects local fixture hosts outside the local profile', () => {
    const azure = {
      INFRA_PROFILE: 'azure',
      PG_HOST: 'pg.internal',
      PG_PORT: '5432',
      PG_DATABASE: 'prometheus',
      AZURE_BLOB_ACCOUNT_URL: 'https://acct.blob.core.windows.net',
      AZURE_KEY_VAULT_URL: 'https://kv.vault.azure.net',
    };
    expect(loadWikiCuratorConfig(azure).crawler.allowLocalFixtureHosts).toBe(false);
    expect(() => loadWikiCuratorConfig({ ...azure, ALLOW_LOCAL_FIXTURE_HOSTS: 'true' })).toThrow(
      /ALLOW_LOCAL_FIXTURE_HOSTS/,
    );
  });

  it('reports missing / invalid variables by name without echoing values', () => {
    try {
      loadWikiCuratorConfig({ ...local, SECRETS_DIR: 'relative/dir', PG_PORT: 'nope' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).message;
      expect(msg).toMatch(/SECRETS_DIR/);
      expect(msg).toMatch(/PG_PORT/);
      expect(msg).not.toMatch(/relative\/dir/);
    }
    expect(() => loadWikiCuratorConfig({})).toThrow(ConfigError);
  });
});
