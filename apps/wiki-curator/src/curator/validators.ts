import { stripInvisible } from '@prometheus/kernel';
import type { ProposalCitation } from '@prometheus/contracts';
import { getPath, hasPath, pathsOverlap, sameValue, withPath } from './paths.js';

/**
 * Deterministic post-validator (ENG-T2 §4 step 3). Pure code, ZERO model calls. A proposal passes only if:
 *  - its node key matches the node bound to the crawl target, its identity paths equal the bound / stored
 *    identity, and it carries no `**` wildcard (identity is never model-chosen; HIGH-2);
 *  - it carries at least one citation, and EVERY citation: (a) has an allowlisted source host, (b) points at a
 *    snapshot the pipeline actually gathered, whose URL is the cited URL, (c) addresses an existing field
 *    path, (d) has a normalised verbatim quote of >= 12 chars that occurs in that snapshot's clean text
 *    (EG-004 / GR-AI-007); `retrieved_at` is rewritten from the snapshot (LOW-3);
 *  - every REQUIRED path is backed by at least one such citation (exact, ancestor or descendant; P1);
 *  - its date windows are ordered (open < close).
 * LOCKED_BY_HUMAN pins (GR-OPS-014) are applied here too: a pinned path keeps its stored value, and a
 * differing proposed value is reported as a lock conflict (not an error).
 */

export const MIN_QUOTE_CHARS = 12;

export type ValidationErrorCode =
  | 'NODE_KEY_MISMATCH'
  | 'NO_CITATIONS'
  | 'CITATION_NOT_ALLOWLISTED'
  | 'CITATION_UNKNOWN_SNAPSHOT'
  | 'CITATION_URL_MISMATCH'
  | 'CITATION_SNAPSHOT_WITHOUT_TEXT'
  | 'CITATION_UNKNOWN_FIELD'
  | 'QUOTE_TOO_SHORT'
  | 'QUOTE_NOT_FOUND'
  | 'DATE_WINDOW_INVERTED'
  /** P1: a required path is not backed by any validator-passing citation (exact, ancestor or descendant). */
  | 'REQUIRED_PATH_UNCITED'
  /** HIGH-2: the proposal's identity differs from the identity bound to the crawl target / stored node. */
  | 'IDENTITY_MISMATCH'
  /** HIGH-2: `**` (universal-diploma wildcard) is ops-only; a model may never emit it. */
  | 'WILDCARD_FROM_MODEL';

export interface ValidationError {
  readonly code: ValidationErrorCode;
  readonly path: string;
  readonly detail: string;
}

export interface LockConflict {
  readonly path: string;
  readonly pinned: unknown;
  readonly proposed: unknown;
}

export interface SourceSnapshotView {
  readonly id: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  /** Clean text from the snapshot store; `null` for error rows (404, timeouts, robots ...). */
  readonly cleanText: string | null;
  /** `wiki.source_snapshot.fetched_at` (ISO): the ONLY source of a citation's `retrieved_at` (LOW-3). */
  readonly retrievedAt: string;
}

export interface ProposalUnderValidation {
  readonly node_key: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly citations: readonly ProposalCitation[];
}

export interface ValidationInput {
  /** Node key bound to the crawl target (never taken from model output; HIGH-2). */
  readonly expectedNodeKey: string;
  readonly nodeKeyOf: (fields: Readonly<Record<string, unknown>>) => string;
  readonly proposal: ProposalUnderValidation;
  readonly snapshots: ReadonlyMap<string, SourceSnapshotView>;
  readonly isAllowlisted: (url: URL) => boolean;
  readonly lockedPaths: readonly string[];
  /** Stored field values of the existing node (`undefined` for a new node). */
  readonly existingFields: Readonly<Record<string, unknown>> | undefined;
  /** Paths that must each be backed by a validator-passing citation (P1). */
  readonly requiredPaths: readonly string[];
  /** Identity paths bound to the target / stored node: each must equal its bound value (HIGH-2). */
  readonly boundIdentity: Readonly<Record<string, unknown>>;
  /** Paths that may never carry the `**` wildcard in model output (HIGH-2). */
  readonly wildcardPaths: readonly string[];
}

export interface ValidationOutcome {
  readonly errors: readonly ValidationError[];
  /** Citations that passed every check, with `retrieved_at` rewritten from their snapshot (LOW-3). */
  readonly citations: readonly ProposalCitation[];
  /** Proposed fields with every LOCKED_BY_HUMAN path restored to its pinned value. */
  readonly effectiveFields: Record<string, unknown>;
  readonly lockConflicts: readonly LockConflict[];
}

const QUOTES: Readonly<Record<string, string>> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '′': "'",
  '´': "'",
  '`': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '‟': '"',
  '″': '"',
  '«': '"',
  '»': '"',
  '‐': '-',
  '‑': '-',
  '‒': '-',
  '–': '-',
  '—': '-',
  '―': '-',
  '−': '-',
};

/**
 * Normalisation applied to BOTH the quote and the snapshot text: kernel `stripInvisible` (all Unicode Cf +
 * C0/C1 controls, exactly what the sanitiser removes from model-visible text), NFC, typographic quotes/dashes folded to ASCII, every whitespace run (incl. NBSP) collapsed to one space.
 * Case and punctuation otherwise stay intact: a paraphrase never matches.
 */

export function normalizeForQuote(text: string): string {
  // MEDIUM-1 (cycle 2): the same invisible set as the sanitiser, on BOTH the quote and the snapshot text
  return stripInvisible(text)
    .normalize('NFC')
    .replace(/[‘’‚‛′´`“”„‟″«»‐-―−]/g, (c) => QUOTES[c] ?? c)
    .replace(/\s+/g, ' ')
    .trim();
}

function sameUrl(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.hash = '';
    y.hash = '';
    return x.href === y.href;
  } catch {
    return false;
  }
}

function checkCitation(
  c: ProposalCitation,
  index: number,
  input: ValidationInput,
  normalizedTexts: Map<string, string>,
): ValidationError[] {
  const at = `citations[${index}]`;
  const errors: ValidationError[] = [];
  let url: URL | undefined;
  try {
    url = new URL(c.source_url);
  } catch {
    url = undefined;
  }
  if (url === undefined || !input.isAllowlisted(url)) {
    errors.push({ code: 'CITATION_NOT_ALLOWLISTED', path: at, detail: c.source_url });
  }
  if (!hasPath(input.proposal.fields, c.field_path)) {
    errors.push({ code: 'CITATION_UNKNOWN_FIELD', path: at, detail: c.field_path });
  }
  const quote = normalizeForQuote(c.verbatim_quote);
  if ([...quote].length < MIN_QUOTE_CHARS) {
    errors.push({ code: 'QUOTE_TOO_SHORT', path: at, detail: `${[...quote].length} < ${MIN_QUOTE_CHARS}` });
  }
  const snapshot = input.snapshots.get(c.snapshot_id);
  if (!snapshot) {
    errors.push({ code: 'CITATION_UNKNOWN_SNAPSHOT', path: at, detail: c.snapshot_id });
    return errors;
  }
  if (!sameUrl(c.source_url, snapshot.finalUrl) && !sameUrl(c.source_url, snapshot.requestedUrl)) {
    errors.push({
      code: 'CITATION_URL_MISMATCH',
      path: at,
      detail: `${c.source_url} != ${snapshot.finalUrl}`,
    });
  }
  if (snapshot.cleanText === null) {
    errors.push({ code: 'CITATION_SNAPSHOT_WITHOUT_TEXT', path: at, detail: snapshot.id });
    return errors;
  }
  let text = normalizedTexts.get(snapshot.id);
  if (text === undefined) {
    text = normalizeForQuote(snapshot.cleanText);
    normalizedTexts.set(snapshot.id, text);
  }
  if (quote.length >= MIN_QUOTE_CHARS && !text.includes(quote)) {
    errors.push({ code: 'QUOTE_NOT_FOUND', path: at, detail: c.verbatim_quote.slice(0, 200) });
  }
  return errors;
}

/** Applies LOCKED_BY_HUMAN pins: pinned paths keep the stored value; differing proposals are conflicts. */
export function applyLocks(
  proposed: Readonly<Record<string, unknown>>,
  lockedPaths: readonly string[],
  existingFields: Readonly<Record<string, unknown>> | undefined,
): { effective: Record<string, unknown>; conflicts: LockConflict[] } {
  let effective: Record<string, unknown> = structuredClone({ ...proposed });
  const conflicts: LockConflict[] = [];
  if (existingFields === undefined) return { effective, conflicts };
  for (const path of lockedPaths) {
    if (!hasPath(existingFields, path)) continue;
    const pinned = getPath(existingFields, path);
    const value = getPath(proposed, path);
    if (!sameValue(pinned, value)) conflicts.push({ path, pinned, proposed: value });
    effective = withPath(effective, path, pinned);
  }
  return { effective, conflicts };
}

export function validateProposal(input: ValidationInput): ValidationOutcome {
  const errors: ValidationError[] = [];
  const { proposal } = input;
  const derivedKey = input.nodeKeyOf(proposal.fields);
  if (proposal.node_key !== input.expectedNodeKey || derivedKey !== input.expectedNodeKey) {
    errors.push({
      code: 'NODE_KEY_MISMATCH',
      path: 'node_key',
      detail: `expected ${input.expectedNodeKey}, proposal ${proposal.node_key}, fields ${derivedKey}`,
    });
  }
  for (const [path, bound] of Object.entries(input.boundIdentity)) {
    if (bound === undefined) continue;
    const proposed = getPath(proposal.fields, path);
    if (!sameValue(proposed, bound)) {
      errors.push({
        code: 'IDENTITY_MISMATCH',
        path,
        detail: `bound ${JSON.stringify(bound)}, proposed ${JSON.stringify(proposed) ?? 'nothing'}`,
      });
    }
  }
  for (const path of input.wildcardPaths) {
    if (getPath(proposal.fields, path) === '**') {
      errors.push({ code: 'WILDCARD_FROM_MODEL', path, detail: "'**' is reserved for ops-configured rules" });
    }
  }
  if (proposal.citations.length === 0) {
    errors.push({ code: 'NO_CITATIONS', path: 'citations', detail: 'at least one citation is required' });
  }
  const normalizedTexts = new Map<string, string>();
  const passing: ProposalCitation[] = [];
  proposal.citations.forEach((c, i) => {
    const citationErrors = checkCitation(c, i, input, normalizedTexts);
    errors.push(...citationErrors);
    const snapshot = input.snapshots.get(c.snapshot_id);
    // LOW-3: retrieved_at is the snapshot's fetch time, never the model's claim
    if (citationErrors.length === 0 && snapshot !== undefined)
      passing.push({ ...c, retrieved_at: snapshot.retrievedAt });
  });
  // P1 / HIGH-1: each required path needs a citation that passed every check above
  for (const path of input.requiredPaths) {
    if (!passing.some((c) => pathsOverlap(c.field_path, path))) {
      errors.push({
        code: 'REQUIRED_PATH_UNCITED',
        path,
        detail: 'no validator-passing verbatim citation covers it',
      });
    }
  }

  const open = getPath(proposal.fields, 'app_window_open_at');
  const close = getPath(proposal.fields, 'app_window_close_at');
  if (typeof open === 'string' && typeof close === 'string' && Date.parse(open) >= Date.parse(close)) {
    errors.push({ code: 'DATE_WINDOW_INVERTED', path: 'app_window_open_at', detail: `${open} >= ${close}` });
  }

  const locks = applyLocks(proposal.fields, input.lockedPaths, input.existingFields);
  return { errors, citations: passing, effectiveFields: locks.effective, lockConflicts: locks.conflicts };
}
