import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SecretNotFoundError, type SecretsPort } from '@prometheus/infra-ports';

const SECRET_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** Local SecretsPort: one file per secret under `dir` (e.g. `./.secrets/wiki_writer_db_password`). */
export class FileSecretsAdapter implements SecretsPort {
  constructor(private readonly dir: string) {}

  async getSecret(name: string): Promise<string> {
    if (!SECRET_NAME.test(name)) throw new SecretNotFoundError(name);
    try {
      const value = (await readFile(join(this.dir, name), 'utf8')).replace(/\r?\n$/, '');
      if (value === '') throw new SecretNotFoundError(name);
      return value;
    } catch (error) {
      if (error instanceof SecretNotFoundError) throw error;
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        throw new SecretNotFoundError(name);
      }
      throw error;
    }
  }
}
