import { createHash } from 'node:crypto';

/** Lower-case hex SHA-256 of raw bytes, or of the UTF-8 encoding of a string. */
export function sha256Hex(input: Uint8Array | string): string {
  const hash = createHash('sha256');
  hash.update(typeof input === 'string' ? Buffer.from(input, 'utf8') : input);
  return hash.digest('hex');
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}
