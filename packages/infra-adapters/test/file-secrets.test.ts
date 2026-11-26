import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SecretNotFoundError } from '@prometheus/infra-ports';
import { FileSecretsAdapter } from '../local/index.js';

describe('[T1-G1] FileSecretsAdapter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prom-secrets-'));
  writeFileSync(join(dir, 'db_password'), 's3cr3t\n');
  writeFileSync(join(dir, 'empty'), '');
  const secrets = new FileSecretsAdapter(dir);

  it('reads one file per secret and strips the trailing newline', async () => {
    await expect(secrets.getSecret('db_password')).resolves.toBe('s3cr3t');
  });

  it('treats missing, empty and path-traversing names as not found', async () => {
    await expect(secrets.getSecret('missing')).rejects.toBeInstanceOf(SecretNotFoundError);
    await expect(secrets.getSecret('empty')).rejects.toBeInstanceOf(SecretNotFoundError);
    await expect(secrets.getSecret('../db_password')).rejects.toBeInstanceOf(SecretNotFoundError);
    await expect(secrets.getSecret('a/b')).rejects.toBeInstanceOf(SecretNotFoundError);
  });
});
