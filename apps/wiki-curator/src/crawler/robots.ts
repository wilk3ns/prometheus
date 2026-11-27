/**
 * Pure robots.txt evaluation (RFC 9309 matching rules, restricted to the `*` user-agent group as ENG-T2 §0
 * Q3 requires): longest matching rule wins, `Allow` wins ties, `*` matches any run of characters and a
 * trailing `$` anchors the end. `Crawl-delay` (non-standard but honoured, capped by the caller) is read from
 * the same group. Unknown lines are ignored; a missing or empty file allows everything.
 */

interface Rule {
  readonly allow: boolean;
  readonly pattern: string;
  readonly regex: RegExp;
}

export interface RobotsPolicy {
  readonly rules: readonly Rule[];
  /** Seconds, as declared (uncapped); `undefined` when absent or malformed. */
  readonly crawlDelaySeconds: number | undefined;
}

export const ALLOW_ALL: RobotsPolicy = { rules: [], crawlDelaySeconds: undefined };

function toRegex(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

/** Parses robots.txt text, keeping only the group(s) addressed to `User-agent: *`. */
export function parseRobots(text: string): RobotsPolicy {
  const rules: Rule[] = [];
  let crawlDelaySeconds: number | undefined;
  let groupAgents: string[] = [];
  let inRules = false; // a rule line ends the user-agent header of the current group

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (key === 'user-agent') {
      if (inRules) {
        groupAgents = [];
        inRules = false;
      }
      groupAgents.push(value.toLowerCase());
      continue;
    }
    if (key !== 'allow' && key !== 'disallow' && key !== 'crawl-delay') continue;
    inRules = true;
    if (!groupAgents.includes('*')) continue;
    if (key === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) crawlDelaySeconds = seconds;
      continue;
    }
    if (value === '') continue; // `Disallow:` with no path = allow all
    const pattern = value.startsWith('/') || value.startsWith('*') ? value : `/${value}`;
    rules.push({ allow: key === 'allow', pattern, regex: toRegex(pattern) });
  }
  return { rules, crawlDelaySeconds };
}

/** Whether `url` (path + query) may be fetched under `policy`. */
export function isAllowedByRobots(policy: RobotsPolicy, url: URL): boolean {
  const target = `${url.pathname}${url.search}`;
  let best: Rule | undefined;
  for (const rule of policy.rules) {
    if (!rule.regex.test(target)) continue;
    const longer = best === undefined || rule.pattern.length > best.pattern.length;
    const tieAllow = best !== undefined && rule.pattern.length === best.pattern.length && rule.allow;
    if (longer || tieAllow) best = rule;
  }
  return best === undefined || best.allow;
}
