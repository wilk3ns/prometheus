import type { DiscoveredLink, SlotCompleteness, SnapshotErrorCode } from '@prometheus/contracts';
import type { StoredSnapshot } from '../persistence/wiki-layer-repository.js';

export type { StoredSnapshot };

/**
 * Step 1 of WF-03 / WF-19 (ENG-T2 §4): snapshot gathering + 404 Healer. Pure planning code over the
 * snapshots already stored for a crawl target (the curator never fetches the web itself).
 *  - a required (seed) URL whose latest snapshot is content: used as is;
 *  - MISSING_SOURCE_404: look for in-allowlist sibling links on any hub snapshot that linked to it, rank them
 *    with a deterministic keyword scorer, and substitute the best one that already has a content snapshot
 *    (an optional model link-healer may only pick among those candidates); otherwise the slot becomes
 *    `MISSING_SOURCE_404`;
 *  - FETCH_TIMEOUT / NETWORK_ERROR (http_status 0): `TRANSIENT_FETCH_FAILURE` (retry; ENG-T2 §0 Q2);
 *  - ROBOTS_DISALLOWED and any other error: `NEEDS_HUMAN_OR_PDF_FETCH` (ENG-T2 §0 Q3).
 */

export interface HealCandidate {
  readonly url: string;
  readonly anchorText: string;
  readonly score: number;
}

export interface SourcePlan {
  /** Content snapshots to read (latest per URL), seeds first. */
  readonly snapshots: readonly StoredSnapshot[];
  readonly slots: SlotCompleteness;
  readonly healed: ReadonlyArray<{ readonly missingUrl: string; readonly replacementUrl: string }>;
  /** 404s with several equally scored candidates (an optional model healer may break the tie). */
  readonly ambiguous: ReadonlyArray<{
    readonly missingUrl: string;
    readonly candidates: readonly HealCandidate[];
  }>;
}

const STOP = new Set([
  'www',
  'http',
  'https',
  'index',
  'php',
  'html',
  'htm',
  'pdf',
  'the',
  'and',
  'for',
  'and',
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9ąćęłńóśźżəğıöşüç]+/)
      .filter((t) => t.length >= 3 && !STOP.has(t)),
  );
}

/** Deterministic sibling score: shared tokens between the missing URL path and candidate url + anchor. */
export function scoreSibling(missingUrl: string, link: DiscoveredLink): number {
  let path = missingUrl;
  try {
    path = new URL(missingUrl).pathname;
  } catch {
    // keep the raw string
  }
  const want = tokens(path);
  let candidatePath = link.url;
  try {
    candidatePath = new URL(link.url).pathname;
  } catch {
    // keep the raw string
  }
  const have = tokens(`${candidatePath} ${link.anchor_text}`);
  let score = 0;
  for (const t of want) if (have.has(t)) score += 1;
  return score;
}

function latestByUrl(rows: readonly StoredSnapshot[]): Map<string, StoredSnapshot> {
  const byUrl = new Map<string, StoredSnapshot>();
  for (const r of [...rows].sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt))) {
    byUrl.set(r.requestedUrl, r);
    byUrl.set(r.finalUrl, r);
  }
  return byUrl;
}

/** A snapshot with stored clean text (the type guard keeps error rows in the false branch). */
type ContentSnapshot = StoredSnapshot & { readonly cleanTextBlobRef: string };

function isContent(s: StoredSnapshot | undefined): s is ContentSnapshot {
  return s !== undefined && s.contentKind !== 'HTTP_ERROR' && s.cleanTextBlobRef !== null;
}

function slotFor(code: SnapshotErrorCode | null): SlotCompleteness[string] {
  switch (code) {
    case 'MISSING_SOURCE_404':
      return { status: 'MISSING_SOURCE_404' };
    case 'FETCH_TIMEOUT':
    case 'NETWORK_ERROR':
      return { status: 'TRANSIENT_FETCH_FAILURE', note: code };
    case 'ROBOTS_DISALLOWED':
      return { status: 'NEEDS_HUMAN_OR_PDF_FETCH', note: 'ROBOTS_DISALLOWED' };
    case null:
      return { status: 'NEEDS_HUMAN_OR_PDF_FETCH', note: 'NO_SNAPSHOT' };
    default:
      return { status: 'NEEDS_HUMAN_OR_PDF_FETCH', note: code };
  }
}

export function planSources(seedUrls: readonly string[], rows: readonly StoredSnapshot[]): SourcePlan {
  const byUrl = latestByUrl(rows);
  const chosen = new Map<string, StoredSnapshot>();
  const slots: Record<string, SlotCompleteness[string]> = {};
  const healed: Array<{ missingUrl: string; replacementUrl: string }> = [];
  const ambiguous: Array<{ missingUrl: string; candidates: HealCandidate[] }> = [];

  for (const seed of seedUrls) {
    const latest = byUrl.get(seed);
    if (isContent(latest)) {
      chosen.set(latest.id, latest);
      continue;
    }
    if (latest?.errorCode === 'MISSING_SOURCE_404') {
      const candidates = siblingsOf(seed, rows, byUrl);
      const best = candidates[0];
      if (best !== undefined && best.score > 0) {
        const tied = candidates.filter((c) => c.score === best.score);
        if (tied.length > 1) ambiguous.push({ missingUrl: seed, candidates: tied });
        const replacement = byUrl.get(best.url);
        if (isContent(replacement)) {
          chosen.set(replacement.id, replacement);
          healed.push({ missingUrl: seed, replacementUrl: best.url });
          continue;
        }
      }
    }
    slots[`source:${seed}`] = slotFor(latest === undefined ? null : latest.errorCode);
  }
  // every other content snapshot of the target (pages discovered by the bounded BFS), deterministic order
  const rest = [...new Set(byUrl.values())]
    .filter((s) => isContent(s) && !chosen.has(s.id))
    .sort((a, b) => a.finalUrl.localeCompare(b.finalUrl));
  return { snapshots: [...chosen.values(), ...rest], slots, healed, ambiguous };
}

function siblingsOf(
  missingUrl: string,
  rows: readonly StoredSnapshot[],
  byUrl: ReadonlyMap<string, StoredSnapshot>,
): HealCandidate[] {
  const seen = new Map<string, HealCandidate>();
  for (const hub of rows) {
    if (!hub.discoveredLinks.some((l) => l.url === missingUrl)) continue;
    for (const link of hub.discoveredLinks) {
      if (link.url === missingUrl || seen.has(link.url)) continue;
      if (!isContent(byUrl.get(link.url))) continue;
      seen.set(link.url, {
        url: link.url,
        anchorText: link.anchor_text,
        score: scoreSibling(missingUrl, link),
      });
    }
  }
  return [...seen.values()].sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
}

/** Applies a (validated) model tie-break: only a URL from the offered candidates is ever accepted. */
export function acceptHealerChoice(
  plan: SourcePlan,
  missingUrl: string,
  chosenUrl: string | null,
  rows: readonly StoredSnapshot[],
): SourcePlan {
  const entry = plan.ambiguous.find((a) => a.missingUrl === missingUrl);
  if (!entry || chosenUrl === null || !entry.candidates.some((c) => c.url === chosenUrl)) return plan;
  const replacement = latestByUrl(rows).get(chosenUrl);
  if (!isContent(replacement)) return plan;
  const previous = plan.healed.find((h) => h.missingUrl === missingUrl);
  const snapshots = plan.snapshots.filter(
    (s) => previous === undefined || s.finalUrl !== previous.replacementUrl,
  );
  return {
    ...plan,
    snapshots: [replacement, ...snapshots.filter((s) => s.id !== replacement.id)],
    healed: [
      ...plan.healed.filter((h) => h.missingUrl !== missingUrl),
      { missingUrl, replacementUrl: chosenUrl },
    ],
  };
}
