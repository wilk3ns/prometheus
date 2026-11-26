import { isIP } from 'node:net';
import type { AllowlistEntry, FetchMode } from '@prometheus/contracts';

function canonicalHost(hostname: string): string {
  const lower = hostname.toLowerCase();
  return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}

/**
 * Official-domain allowlist matcher (`wiki.official_domain_allowlist`): a host matches an entry when it
 * equals `entry.host`, or is a strict subdomain of it and `allow_subdomains` is true. When several entries
 * match, the most specific (longest) host wins, so `irk.pw.edu.pl` (JS_CATALOG, no subdomains) overrides
 * `pw.edu.pl` for that exact host. IP-literal hosts never match.
 */
export class DomainAllowlist {
  private readonly byHost: ReadonlyMap<string, AllowlistEntry>;

  constructor(entries: readonly AllowlistEntry[]) {
    this.byHost = new Map(entries.map((e) => [canonicalHost(e.host), e]));
  }

  get size(): number {
    return this.byHost.size;
  }

  match(hostname: string): AllowlistEntry | undefined {
    const host = canonicalHost(hostname);
    if (host === '' || isIP(host.replace(/^\[|\]$/g, '')) !== 0) return undefined;
    const exact = this.byHost.get(host);
    if (exact) return exact;
    const labels = host.split('.');
    for (let i = 1; i < labels.length; i += 1) {
      const parent = labels.slice(i).join('.');
      const entry = this.byHost.get(parent);
      // An entry without allow_subdomains only covers its exact host; keep walking to broader parents.
      if (entry?.allow_subdomains === true) return entry;
    }
    return undefined;
  }

  allows(url: URL): boolean {
    return (url.protocol === 'http:' || url.protocol === 'https:') && this.match(url.hostname) !== undefined;
  }

  fetchModeFor(url: URL): FetchMode | undefined {
    return this.match(url.hostname)?.default_fetch_mode;
  }
}
