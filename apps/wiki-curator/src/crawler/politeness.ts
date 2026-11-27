import type {
  HttpFetcherPort,
  HttpFetchOutcome,
  JsRendererPort,
  RenderOutcome,
} from '@prometheus/infra-ports';
import { ALLOW_ALL, isAllowedByRobots, parseRobots, type RobotsPolicy } from './robots.js';

/**
 * Crawl politeness (ENG-T2 §0 Q3), applied to every non-local host:
 *  - robots.txt is fetched once per origin through the SAME guarded Tier 1 fetcher (GuardedHttpClient:
 *    allowlist, address policy, size cap), cached for 1 h; 404 / any non-2xx / unreachable = allow all;
 *  - a URL disallowed for `*` is never requested (`ROBOTS_DISALLOWED`);
 *  - per host: at most 2 requests in flight and request starts spaced by max(1 s, Crawl-delay <= 5 s)
 *    (a token bucket of capacity 1 refilled at 1 token/s, slowed by Crawl-delay).
 * Local fixture hosts (only ever non-empty with INFRA_PROFILE=local + ALLOW_LOCAL_FIXTURE_HOSTS=true) are
 * exempt. Applied as decorators around the Tier 1 / Tier 2 ports, chosen in the composition root.
 */

export const POLITENESS_POLICY = {
  minIntervalMs: 1_000,
  maxConcurrencyPerHost: 2,
  maxCrawlDelayMs: 5_000,
  robotsTtlMs: 60 * 60 * 1_000,
  /** RFC 9309 §2.5: parse at least 500 KiB; anything beyond is ignored. */
  robotsMaxBytes: 500 * 1024,
} as const;

export interface PolitenessDeps {
  /** Fetcher used for robots.txt (the guarded Tier 1 fetcher, never a raw socket). */
  readonly robotsFetcher: HttpFetcherPort;
  /** Hostnames exempt from politeness (local fixture hosts only). */
  readonly exemptHosts: ReadonlySet<string>;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface HostState {
  nextStartAt: number;
  inFlight: number;
  readonly waiters: Array<() => void>;
}

interface CachedRobots {
  readonly policy: Promise<RobotsPolicy>;
  readonly expiresAt: number;
}

export type Admission = { readonly kind: 'GO'; release(): void } | { readonly kind: 'ROBOTS_DISALLOWED' };

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class CrawlPoliteness {
  private readonly hosts = new Map<string, HostState>();
  private readonly robots = new Map<string, CachedRobots>();
  private readonly nowMs: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: PolitenessDeps) {
    this.nowMs = deps.nowMs ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /** Waits for a polite slot for `url`, or refuses it when robots.txt disallows it. */
  async admit(url: URL): Promise<Admission> {
    const host = url.hostname.toLowerCase();
    if (this.deps.exemptHosts.has(host)) return { kind: 'GO', release: () => undefined };
    const policy = await this.policyFor(url);
    if (!isAllowedByRobots(policy, url)) return { kind: 'ROBOTS_DISALLOWED' };
    return this.acquire(host, intervalFor(policy));
  }

  private policyFor(url: URL): Promise<RobotsPolicy> {
    const origin = url.origin;
    const cached = this.robots.get(origin);
    if (cached && cached.expiresAt > this.nowMs()) return cached.policy;
    const policy = this.fetchRobots(url);
    this.robots.set(origin, { policy, expiresAt: this.nowMs() + POLITENESS_POLICY.robotsTtlMs });
    return policy;
  }

  private async fetchRobots(url: URL): Promise<RobotsPolicy> {
    const host = url.hostname.toLowerCase();
    // the robots.txt request is itself a request to the host: it takes a polite slot too
    const slot = await this.acquire(host, POLITENESS_POLICY.minIntervalMs);
    let outcome: HttpFetchOutcome;
    try {
      outcome = await this.deps.robotsFetcher.fetch(new URL('/robots.txt', url.origin));
    } finally {
      slot.release();
    }
    if (outcome.kind !== 'RESPONSE' || outcome.status < 200 || outcome.status >= 300) return ALLOW_ALL;
    const body = Buffer.from(outcome.body.subarray(0, POLITENESS_POLICY.robotsMaxBytes));
    return parseRobots(body.toString('utf8'));
  }

  private async acquire(host: string, intervalMs: number): Promise<Admission & { kind: 'GO' }> {
    let state = this.hosts.get(host);
    if (!state) {
      state = { nextStartAt: 0, inFlight: 0, waiters: [] };
      this.hosts.set(host, state);
    }
    while (state.inFlight >= POLITENESS_POLICY.maxConcurrencyPerHost) {
      await new Promise<void>((resolve) => state.waiters.push(resolve));
    }
    state.inFlight += 1;
    const now = this.nowMs();
    const startAt = Math.max(now, state.nextStartAt);
    state.nextStartAt = startAt + intervalMs; // reserve before sleeping: concurrent callers queue behind
    if (startAt > now) await this.sleep(startAt - now);
    let released = false;
    const hostState = state;
    return {
      kind: 'GO',
      release: () => {
        if (released) return;
        released = true;
        hostState.inFlight -= 1;
        hostState.waiters.shift()?.();
      },
    };
  }
}

function intervalFor(policy: RobotsPolicy): number {
  const delayMs =
    policy.crawlDelaySeconds === undefined
      ? 0
      : Math.min(policy.crawlDelaySeconds * 1_000, POLITENESS_POLICY.maxCrawlDelayMs);
  return Math.max(POLITENESS_POLICY.minIntervalMs, delayMs);
}

/** Tier 1 decorator: robots check + polite slot around every top-level fetch. */
export class PoliteHttpFetcher implements HttpFetcherPort {
  constructor(
    private readonly inner: HttpFetcherPort,
    private readonly politeness: CrawlPoliteness,
  ) {}

  async fetch(url: URL): Promise<HttpFetchOutcome> {
    const admission = await this.politeness.admit(url);
    if (admission.kind === 'ROBOTS_DISALLOWED') return { kind: 'ROBOTS_DISALLOWED', requestedUrl: url.href };
    try {
      return await this.inner.fetch(url);
    } finally {
      admission.release();
    }
  }
}

/** Tier 2 decorator: robots check + polite slot around every render (the main document request). */
export class PoliteJsRenderer implements JsRendererPort {
  constructor(
    private readonly inner: JsRendererPort,
    private readonly politeness: CrawlPoliteness,
  ) {}

  async render(url: URL): Promise<RenderOutcome> {
    const admission = await this.politeness.admit(url);
    if (admission.kind === 'ROBOTS_DISALLOWED') return { kind: 'ROBOTS_DISALLOWED' };
    try {
      return await this.inner.render(url);
    } finally {
      admission.release();
    }
  }

  blockedProxyRequests(): number {
    return this.inner.blockedProxyRequests();
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
