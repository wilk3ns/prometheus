import { readFileSync } from 'node:fs';
import { canonicalJson, sha256Hex } from '@prometheus/kernel';
import { meta as linkHealer } from './wiki.link_healer/meta.js';
import { meta as baselineExtract } from './wiki.baseline_extract/meta.js';
import { meta as deepExtract } from './wiki.deep_extract/meta.js';
import { meta as deepVerify } from './wiki.deep_verify/meta.js';
import { meta as triage } from './matching.triage/meta.js';
import type { PromptMeta } from './prompt-meta.js';

export type { PromptMeta } from './prompt-meta.js';

/**
 * Versioned prompt registry (ENG-T2 §1 `prompts/`). Each prompt lives in its own folder as `system.md` +
 * `user.tmpl` + `meta.ts` (id, version, sha256 lock). Loading recomputes the hash over the two text files
 * and fails if it differs from the lock, so a prompt can never change without a version/hash bump that
 * reviewers see (and that changes every replay-cassette key, so stale cassettes miss loudly).
 *
 * Templates use `{{name}}` placeholders. `{{nonce}}` and `{{untrusted}}` are filled by the router; every
 * other placeholder must be supplied by the caller (missing or extra variables are errors). String values
 * are inserted as-is, all other values as canonical JSON.
 */

export interface LoadedPrompt extends PromptMeta {
  readonly system: string;
  readonly userTemplate: string;
}

export class PromptIntegrityError extends Error {
  override readonly name = 'PromptIntegrityError';
}

export class PromptRenderError extends Error {
  override readonly name = 'PromptRenderError';
}

const METAS: readonly PromptMeta[] = [linkHealer, baselineExtract, deepExtract, deepVerify, triage];

/** Hash over both files, NUL-separated (the value stored in each `meta.ts`). */
export function promptContentHash(system: string, userTemplate: string): string {
  return sha256Hex(`${system}\u0000${userTemplate}`);
}

const loaded = new Map<string, LoadedPrompt>();

export function loadPrompt(id: string): LoadedPrompt {
  const cached = loaded.get(id);
  if (cached) return cached;
  const meta = METAS.find((m) => m.id === id);
  if (!meta) throw new PromptIntegrityError(`unknown prompt '${id}'`);
  const read = (file: string): string =>
    readFileSync(new URL(`./${id}/${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const system = read('system.md');
  const userTemplate = read('user.tmpl');
  const actual = promptContentHash(system, userTemplate);
  if (actual !== meta.sha256) {
    throw new PromptIntegrityError(
      `prompt '${id}' v${meta.version} content hash ${actual} does not match its lock ${meta.sha256}`,
    );
  }
  const prompt: LoadedPrompt = { ...meta, system, userTemplate };
  loaded.set(id, prompt);
  return prompt;
}

export function listPromptIds(): string[] {
  return METAS.map((m) => m.id);
}

const PLACEHOLDER = /\{\{([a-z_]+)\}\}/g;
const ROUTER_FILLED: ReadonlySet<string> = new Set(['nonce', 'untrusted']);

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : canonicalJson(value);
}

/** Placeholders a template requires from the caller (router-filled ones excluded). */
export function templateVariables(template: string): Set<string> {
  const names = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER)) {
    const name = m[1];
    if (name !== undefined && !ROUTER_FILLED.has(name)) names.add(name);
  }
  return names;
}

export function renderTemplate(
  template: string,
  vars: Readonly<Record<string, unknown>>,
  routerFilled: { readonly nonce: string; readonly untrusted: string },
): string {
  return template.replace(PLACEHOLDER, (_m, name: string) => {
    if (name === 'nonce') return routerFilled.nonce;
    if (name === 'untrusted') return routerFilled.untrusted;
    if (!Object.hasOwn(vars, name)) throw new PromptRenderError(`missing template variable '${name}'`);
    return stringify(vars[name]);
  });
}

/** Checks that `vars` supplies exactly the caller variables both templates of `prompt` use. */
export function assertVariables(prompt: LoadedPrompt, vars: Readonly<Record<string, unknown>>): void {
  const needed = new Set([...templateVariables(prompt.system), ...templateVariables(prompt.userTemplate)]);
  for (const name of needed) {
    if (!Object.hasOwn(vars, name)) throw new PromptRenderError(`missing template variable '${name}'`);
  }
  for (const name of Object.keys(vars)) {
    if (!needed.has(name)) throw new PromptRenderError(`unexpected template variable '${name}'`);
  }
}
