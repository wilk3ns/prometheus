import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadAiConfig, loadWikiCuratorConfig } from '../src/index.js';

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

  it('[LOW-1] fixture exemption is host-scoped and empty unless explicitly enabled', () => {
    expect(loadWikiCuratorConfig(local).crawler.localFixtureHosts).toEqual([]);
    expect(
      loadWikiCuratorConfig({ ...local, ALLOW_LOCAL_FIXTURE_HOSTS: 'true' }).crawler.localFixtureHosts,
    ).toEqual(['localhost']);
    expect(
      loadWikiCuratorConfig({
        ...local,
        ALLOW_LOCAL_FIXTURE_HOSTS: 'true',
        LOCAL_FIXTURE_HOSTS: 'Fixture.Local, localhost',
      }).crawler.localFixtureHosts,
    ).toEqual(['fixture.local', 'localhost']);
    expect(() =>
      loadWikiCuratorConfig({ ...local, ALLOW_LOCAL_FIXTURE_HOSTS: 'true', LOCAL_FIXTURE_HOSTS: 'http://x' }),
    ).toThrow(/LOCAL_FIXTURE_HOSTS/);
  });
});

describe('[T2-G4][MEDIUM-6] loadAiConfig: APPLICANT_PII approval is bound to an EU endpoint', () => {
  const live = { AI_MODE: 'live' };
  const openai = (env: Record<string, string>) => {
    const cfg = loadAiConfig({ ...live, ...env });
    if (cfg.mode !== 'live') throw new Error('expected live');
    return cfg.openai;
  };

  it('denies by default (no base URL = the US endpoint)', () => {
    expect(openai({}).piiApproved).toBe(false);
    expect(openai({ OPENAI_PII_EU_HOSTS: 'eu.api.openai.com' }).piiApproved).toBe(false);
  });

  it('approves only a base URL whose host is explicitly listed as an EU endpoint', () => {
    expect(
      openai({ OPENAI_BASE_URL: 'https://eu.api.openai.com/v1', OPENAI_PII_EU_HOSTS: 'eu.api.openai.com' })
        .piiApproved,
    ).toBe(true);
    expect(openai({ OPENAI_BASE_URL: 'https://eu.api.openai.com/v1' }).piiApproved).toBe(false);
    expect(
      openai({ OPENAI_BASE_URL: 'https://other.example.com/v1', OPENAI_PII_EU_HOSTS: 'eu.api.openai.com' })
        .piiApproved,
    ).toBe(false);
  });

  it('refuses to list the US endpoint as PII-approved', () => {
    expect(() => loadAiConfig({ ...live, OPENAI_PII_EU_HOSTS: 'api.openai.com' })).toThrow(ConfigError);
  });

  it('replay mode needs no keys and no endpoint', () => {
    expect(loadAiConfig({ AI_CASSETTE_DIR: process.cwd() })).toEqual({
      mode: 'replay',
      cassetteDir: process.cwd(),
    });
  });
});

describe('[T2-G9][LOW-6] PG_SSLMODE', () => {
  it('defaults to disable only for the local profile and honours an explicit mode', () => {
    expect(loadWikiCuratorConfig(local).postgres.sslmode).toBe('disable');
    expect(loadWikiCuratorConfig({ ...local, PG_SSLMODE: 'verify-full' }).postgres.sslmode).toBe(
      'verify-full',
    );
  });
});
