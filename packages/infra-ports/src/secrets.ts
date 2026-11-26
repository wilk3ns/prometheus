export class SecretNotFoundError extends Error {
  override readonly name = 'SecretNotFoundError';
  constructor(readonly secretName: string) {
    super(`Secret '${secretName}' is not available`);
  }
}

/** Read-only secret lookup (Key Vault in prod, `./.secrets/<name>` files locally). */
export interface SecretsPort {
  /** @throws SecretNotFoundError when the secret does not exist. */
  getSecret(name: string): Promise<string>;
}
