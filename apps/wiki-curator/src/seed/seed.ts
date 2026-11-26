import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { SeedFile } from '@prometheus/contracts';
import type { IdGen } from '@prometheus/kernel';
import { type AllowlistOptions, DomainAllowlist } from '../crawler/allowlist.js';
import { parseHttpUrl } from '../crawler/url.js';
import type { WikiRepository } from '../persistence/wiki-repository.js';

export class SeedValidationError extends Error {
  override readonly name = 'SeedValidationError';
  constructor(readonly problems: readonly string[]) {
    super(`Invalid seed file:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

/**
 * Validates a seed document: schema (seed-targets-v1.0), unique hosts / target keys, and every seed URL
 * must be covered by the allowlist in the same document under the same port policy the crawler applies
 * (default ports only, except configured local fixture hosts), since the crawler would refuse it anyway.
 */
export function parseSeed(json: unknown, allowlistOptions: AllowlistOptions = {}): SeedFile {
  const parsed = SeedFile.safeParse(json);
  if (!parsed.success) {
    throw new SeedValidationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const seed = parsed.data;
  const problems: string[] = [];
  const hosts = new Set<string>();
  for (const d of seed.allowlisted_domains) {
    if (hosts.has(d.host)) problems.push(`duplicate allowlisted host ${d.host}`);
    hosts.add(d.host);
  }
  const allowlist = new DomainAllowlist(seed.allowlisted_domains, allowlistOptions);
  const keys = new Set<string>();
  for (const t of seed.crawl_targets) {
    if (keys.has(t.target_key)) problems.push(`duplicate target_key ${t.target_key}`);
    keys.add(t.target_key);
    for (const u of t.seed_urls) {
      const url = parseHttpUrl(u);
      if (!url || !allowlist.allows(url)) problems.push(`${t.target_key}: seed URL not on allowlist: ${u}`);
    }
  }
  if (problems.length > 0) throw new SeedValidationError(problems);
  return seed;
}

export async function readSeedFile(path: string, allowlistOptions: AllowlistOptions = {}): Promise<SeedFile> {
  if (!isAbsolute(path)) throw new SeedValidationError([`seed file path must be absolute: ${path}`]);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new SeedValidationError([
      `cannot read seed file ${path}: ${error instanceof Error ? error.message : ''}`,
    ]);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SeedValidationError([`seed file is not valid JSON: ${path}`]);
  }
  return parseSeed(json, allowlistOptions);
}

/** Idempotent upsert of allowlist + targets (existing targets keep their id). */
export function applySeed(
  repo: Pick<WikiRepository, 'upsertSeed'>,
  seed: SeedFile,
  ids: IdGen,
): Promise<{ allowlistUpserted: number; targetsUpserted: number }> {
  return repo.upsertSeed(
    seed.allowlisted_domains,
    seed.crawl_targets.map((t) => ({ ...t, id: ids.next() })),
  );
}
