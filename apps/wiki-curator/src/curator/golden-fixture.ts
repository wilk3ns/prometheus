import { Citation } from '@prometheus/contracts';
import { z } from 'zod';

/**
 * Strict reader over a wiki-v2.0 golden fixture JSON. Every accessor names the exact JSON path it reads and
 * throws `GoldenFixtureError(path)` when the value is missing or has the wrong type: the importer never fills
 * a gap with a guess.
 */
export class GoldenFixtureError extends Error {
  override readonly name = 'GoldenFixtureError';
  constructor(
    readonly file: string,
    readonly path: string,
    message: string,
  ) {
    super(`${file} $.${path}: ${message}`);
  }
}

type Json = unknown;

function isRecord(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class FixtureNode {
  constructor(
    readonly file: string,
    readonly path: string,
    readonly value: Json,
  ) {}

  fail(message: string, path = this.path): never {
    throw new GoldenFixtureError(this.file, path, message);
  }

  at(key: string): FixtureNode {
    if (!isRecord(this.value)) this.fail('is not an object');
    const path = this.path === '' ? key : `${this.path}.${key}`;
    if (!Object.hasOwn(this.value, key)) this.fail('is missing', path);
    return new FixtureNode(this.file, path, this.value[key]);
  }

  has(key: string): boolean {
    return isRecord(this.value) && Object.hasOwn(this.value, key);
  }

  str(key: string): string {
    const n = this.at(key);
    const v = n.value;
    return typeof v === 'string' ? v : n.fail('is not a string');
  }

  num(key: string): number {
    const n = this.at(key);
    const v = n.value;
    return typeof v === 'number' && Number.isFinite(v) ? v : n.fail('is not a number');
  }

  bool(key: string): boolean {
    const n = this.at(key);
    const v = n.value;
    return typeof v === 'boolean' ? v : n.fail('is not a boolean');
  }

  nullable<T>(key: string, read: (node: FixtureNode) => T): T | null {
    const n = this.at(key);
    return n.value === null ? null : read(n);
  }

  strings(key: string): string[] {
    const n = this.at(key);
    const v = n.value;
    if (!Array.isArray(v)) return n.fail('is not a string array');
    return v.map((item: unknown) => (typeof item === 'string' ? item : n.fail('is not a string array')));
  }

  list(key: string): FixtureNode[] {
    const n = this.at(key);
    const v = n.value;
    if (!Array.isArray(v)) return n.fail('is not an array');
    return v.map((item: unknown, i) => new FixtureNode(this.file, `${n.path}[${i}]`, item));
  }

  /** The object at this node, without the given keys (e.g. `citations`), as a plain JSON record. */
  objectWithout(...keys: string[]): Record<string, unknown> {
    if (!isRecord(this.value)) this.fail('is not an object');
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(this.value)) if (!keys.includes(k)) out[k] = structuredClone(v);
    return out;
  }

  /** `citations[]` of a layer object, validated (snapshot ids do not exist for golden records). */
  citations(mapPath: (fixturePath: string) => string): Citation[] {
    return this.list('citations').map((c) => {
      const parsed = Citation.safeParse({
        field_path: mapPath(c.str('field_path')),
        snapshot_id: null,
        source_url: c.str('source_url'),
        verbatim_quote: c.str('verbatim_quote'),
        retrieved_at: c.str('retrieved_at'),
      });
      return parsed.success
        ? parsed.data
        : c.fail(`invalid citation: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    });
  }
}

const Envelope = z.looseObject({ schema_version: z.literal('wiki-v2.0'), compiled_key: z.string() });

export function openFixture(file: string, json: unknown): FixtureNode {
  const env = Envelope.safeParse(json);
  if (!env.success) throw new GoldenFixtureError(file, 'schema_version', 'is not a wiki-v2.0 golden record');
  return new FixtureNode(file, '', json);
}
