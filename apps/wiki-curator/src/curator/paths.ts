import { canonicalJson } from '@prometheus/kernel';

/**
 * Dotted field paths over layer field objects (`tuition_annual_eur`, `program.instruction_language`,
 * `program_requirements_json.calls_non_eu_abroad`). Used for citations, abstentions and LOCKED_BY_HUMAN pins.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function splitPath(path: string): string[] {
  const parts = path.split('.');
  if (parts.some((p) => p === '')) throw new RangeError(`malformed field path '${path}'`);
  return parts;
}

export function hasPath(root: unknown, path: string): boolean {
  let node: unknown = root;
  for (const part of splitPath(path)) {
    if (!isRecord(node) || !Object.hasOwn(node, part)) return false;
    node = node[part];
  }
  return true;
}

export function getPath(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const part of splitPath(path)) {
    if (!isRecord(node) || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

/** Returns a copy of `root` with `path` set to `value` (intermediate objects created as needed). */
export function withPath<T>(root: T, path: string, value: unknown): T {
  const parts = splitPath(path);
  const clone = structuredClone(root);
  if (!isRecord(clone)) throw new RangeError('root must be an object');
  const leaf = parts.pop();
  if (leaf === undefined) throw new RangeError('empty field path');
  let node: Record<string, unknown> = clone;
  for (const part of parts) {
    const existing = node[part];
    const child: Record<string, unknown> = isRecord(existing) ? existing : {};
    node[part] = child;
    node = child;
  }
  node[leaf] = structuredClone(value);
  return clone;
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalJson(a) === canonicalJson(b);
}

/** True when `a` and `b` are the same path or one is an ancestor of the other (`program` / `program.name_en`). */
export function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}
