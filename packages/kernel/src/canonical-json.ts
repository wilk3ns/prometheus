export class CanonicalJsonError extends Error {
  override readonly name = 'CanonicalJsonError';
}

/**
 * Deterministic JSON serialisation: object keys sorted by UTF-16 code unit order, no insignificant
 * whitespace. Values that have no stable JSON form (undefined, functions, symbols, bigint,
 * non-finite numbers) are rejected rather than silently dropped, so hashes over the output are stable.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(`non-finite number at ${path}`);
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => serialize(item, `${path}[${i}]`)).join(',')}]`;
      }
      if (value instanceof Date) return JSON.stringify(value.toISOString());
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError(`unsupported object type at ${path}`);
      }
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      );
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, `${path}.${k}`)}`).join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`unsupported ${typeof value} at ${path}`);
  }
}
