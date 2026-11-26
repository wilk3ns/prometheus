import type { NotFetchedReason } from '@prometheus/contracts';
import type { HopRefusal, JsRendererPort, RenderOutcome } from '@prometheus/infra-ports';
import {
  chromium,
  errors,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
} from 'playwright';
import type { GuardedHttpClient, HopResult } from './guarded-http.js';
import { CRAWL_POLICY } from './policy.js';

/**
 * Tier 2 renderer (ENG-T1 §3 rule 2) for JS/AJAX catalogs. Plain headless Chromium with the same honest
 * User-Agent as Tier 1: NO stealth/evasion plugins, NO CAPTCHA solving (challenge pages are detected and
 * recorded upstream, never bypassed).
 *
 * Egress policy (Chromium never opens a network connection itself):
 *  - every HTTP(S) request of every page in the browser context is intercepted (`context.route`) and served
 *    through the GuardedHttpClient: allowlist / public-address pre-check, connect-time address re-check,
 *    15 MB raw+decoded cap, render-wide deadline;
 *  - documents (main frame and iframes) must be on the official allowlist; sub-resources (scripts, XHR,
 *    fetch, CSS, beacons) may come from public third-party hosts, never from non-public addresses;
 *  - main-frame redirects are never handed to Chromium: the hop is recorded, aborted, and `render()`
 *    navigates to the Location itself, so each hop is checked before any request to it is sent;
 *  - popups / any page other than the crawl page are closed and their requests aborted;
 *  - WebSockets are closed before any server contact (`routeWebSocket`; T1 needs none);
 *  - image/media/font requests and analytics trackers are aborted; service workers, downloads, WebRTC
 *    non-proxied UDP and DNS prefetch are disabled.
 */

const BLOCKED_RESOURCE_TYPES: ReadonlySet<string> = new Set(['image', 'media', 'font']);
const TRACKER_HOST =
  /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.(com|net)|hotjar\.(com|io))$/i;
/** Response headers that describe the wire encoding, which no longer applies to the decoded body. */
const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);
const CHROMIUM_ARGS = ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--dns-prefetch-disable'];

export interface Tier2Options {
  /** Hard wall-clock budget for one render, all hops included (default 25 s). */
  readonly renderDeadlineMs?: number;
  /** `networkidle` wait cap after `domcontentloaded` (default 10 s). */
  readonly networkIdleCapMs?: number;
  /** Cap on the rendered `outerHTML` (default 15 MB). */
  readonly maxHtmlBytes?: number;
}

/** Mutable per-render state shared with the route handler. */
class NavigationState {
  /** Status of the redirect that led to the navigation currently in flight (0 for the first hop). */
  viaStatus = 0;
  private redirect: { status: number; location: string } | undefined;
  refusal: { status: number; refusedUrl: string; refusal: HopRefusal } | undefined;
  mainFailure: { reason: NotFetchedReason; detail: string } | undefined;

  setRedirect(r: { status: number; location: string }): void {
    this.redirect = r;
  }

  /** Returns and clears the redirect recorded by the route handler for the last navigation. */
  takeRedirect(): { status: number; location: string } | undefined {
    const r = this.redirect;
    this.redirect = undefined;
    return r;
  }

  refused(): RenderOutcome | undefined {
    if (this.refusal) return { kind: 'HOP_REFUSED', ...this.refusal };
    if (this.mainFailure) return { kind: 'FAILED', ...this.mainFailure };
    return undefined;
  }
}

function failure(error: unknown): RenderOutcome {
  if (error instanceof errors.TimeoutError)
    return { kind: 'FAILED', reason: 'TIMEOUT', detail: 'navigation timeout' };
  return {
    kind: 'FAILED',
    reason: 'RENDER_FAILED',
    detail: error instanceof Error ? error.message : String(error),
  };
}

function fulfilHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (!DROPPED_RESPONSE_HEADERS.has(k)) out[k] = v;
  return out;
}

function refusalOf(decision: Extract<HopResult, { kind: 'REFUSED' }>['decision']): HopRefusal {
  return decision === 'BLOCKED_PRIVATE_ADDRESS' ? 'BLOCKED_PRIVATE_ADDRESS' : 'DISALLOWED_REDIRECT';
}

export class PlaywrightJsRenderer implements JsRendererPort {
  private browser: Promise<Browser> | undefined;
  private readonly renderDeadlineMs: number;
  private readonly networkIdleCapMs: number;
  private readonly maxHtmlBytes: number;

  constructor(
    private readonly client: GuardedHttpClient,
    private readonly userAgent: string,
    options: Tier2Options = {},
  ) {
    this.renderDeadlineMs = options.renderDeadlineMs ?? CRAWL_POLICY.tier2RenderDeadlineMs;
    this.networkIdleCapMs = options.networkIdleCapMs ?? CRAWL_POLICY.tier2NetworkIdleCapMs;
    this.maxHtmlBytes = options.maxHtmlBytes ?? CRAWL_POLICY.maxBodyBytes;
  }

  private launch(): Promise<Browser> {
    this.browser ??= chromium.launch({ headless: true, args: CHROMIUM_ARGS });
    return this.browser;
  }

  async render(url: URL): Promise<RenderOutcome> {
    let context: BrowserContext | undefined;
    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
      void context?.close().catch(() => undefined);
    }, this.renderDeadlineMs);
    const deadlineFailure: RenderOutcome = {
      kind: 'FAILED',
      reason: 'TIMEOUT',
      detail: `render deadline ${this.renderDeadlineMs} ms exceeded`,
    };

    try {
      const browser = await this.launch();
      context = await browser.newContext({
        userAgent: this.userAgent,
        locale: 'en-US',
        extraHTTPHeaders: { 'accept-language': CRAWL_POLICY.acceptLanguage },
        serviceWorkers: 'block',
        acceptDownloads: false,
      });
      const page = await context.newPage();
      const state = new NavigationState();
      context.on('page', (other) => {
        if (other !== page) void other.close().catch(() => undefined);
      });
      await context.routeWebSocket(/.*/, (ws) => {
        void ws.close({ code: 1008, reason: 'WebSockets are not permitted for snapshot rendering' });
      });
      await context.route('**/*', (route, request) =>
        this.handle(route, request, page, state, abort.signal).catch(async () => {
          await route.abort('failed').catch(() => undefined);
        }),
      );

      let current = url.href;
      let response;
      for (let hop = 0; response === undefined; hop += 1) {
        if (hop > CRAWL_POLICY.maxRedirects) {
          return {
            kind: 'FAILED',
            reason: 'TOO_MANY_REDIRECTS',
            detail: `> ${CRAWL_POLICY.maxRedirects} hops`,
          };
        }
        state.takeRedirect();
        try {
          response =
            (await page.goto(current, {
              waitUntil: 'domcontentloaded',
              timeout: CRAWL_POLICY.tier2NavigationTimeoutMs,
            })) ?? undefined;
          if (response === undefined)
            return { kind: 'FAILED', reason: 'RENDER_FAILED', detail: 'no response' };
        } catch (error) {
          if (timedOut) return deadlineFailure;
          const refused = state.refused();
          if (refused) return refused;
          const redirect = state.takeRedirect();
          if (redirect === undefined) return failure(error);
          state.viaStatus = redirect.status;
          current = redirect.location;
        }
      }
      const refusedEarly = state.refused();
      if (refusedEarly) return refusedEarly;

      try {
        await page.waitForLoadState('networkidle', { timeout: this.networkIdleCapMs });
      } catch (error) {
        // networkidle is capped by contract: a page that keeps polling is rendered as-is after the cap.
        if (!(error instanceof errors.TimeoutError)) throw error;
      }
      const refusedLate = state.refused();
      if (refusedLate) return refusedLate;

      const length: unknown = await page.evaluate('document.documentElement.outerHTML.length');
      if (typeof length !== 'number' || length > this.maxHtmlBytes) {
        return {
          kind: 'FAILED',
          reason: 'BODY_TOO_LARGE',
          detail: `rendered HTML exceeds ${this.maxHtmlBytes}`,
        };
      }
      const html: unknown = await page.evaluate('document.documentElement.outerHTML');
      if (typeof html !== 'string')
        return { kind: 'FAILED', reason: 'RENDER_FAILED', detail: 'outerHTML not a string' };
      if (Buffer.byteLength(html, 'utf8') > this.maxHtmlBytes) {
        return {
          kind: 'FAILED',
          reason: 'BODY_TOO_LARGE',
          detail: `rendered HTML exceeds ${this.maxHtmlBytes}`,
        };
      }
      if (timedOut) return deadlineFailure;
      return {
        kind: 'RENDERED',
        finalUrl: page.url(),
        status: response.status(),
        headers: await response.allHeaders(),
        html,
      };
    } catch (error) {
      if (timedOut) return deadlineFailure;
      throw error;
    } finally {
      clearTimeout(timer);
      await context?.close().catch(() => undefined);
    }
  }

  private async handle(
    route: Route,
    request: Request,
    crawlPage: Page,
    state: NavigationState,
    signal: AbortSignal,
  ): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      await route.abort('blockedbyclient');
      return;
    }
    const frame = request.frame();
    if (
      frame.page() !== crawlPage ||
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      BLOCKED_RESOURCE_TYPES.has(request.resourceType()) ||
      TRACKER_HOST.test(url.hostname)
    ) {
      await route.abort('blockedbyclient');
      return;
    }

    const isDocument = request.isNavigationRequest();
    const isMain = isDocument && frame === crawlPage.mainFrame();
    let method = request.method();
    let body: Buffer | undefined = request.postDataBuffer() ?? undefined;
    const headers = await request.allHeaders();

    for (let hops = 0; ; hops += 1) {
      const res = await this.client.send({
        url,
        scope: isDocument ? 'ALLOWLISTED' : 'ANY_PUBLIC_HOST',
        signal,
        method,
        headers,
        body,
      });
      if (res.kind === 'REFUSED') {
        if (isMain)
          state.refusal = { status: state.viaStatus, refusedUrl: url.href, refusal: refusalOf(res.decision) };
        await route.abort('blockedbyclient');
        return;
      }
      if (res.kind === 'FAILED') {
        if (isMain) state.mainFailure = { reason: res.reason, detail: `tier2 main document: ${res.detail}` };
        await route.abort('failed');
        return;
      }
      if (res.redirectTo === undefined) {
        await route.fulfill({ status: res.status, headers: fulfilHeaders(res.headers), body: res.body });
        return;
      }
      const nextIsHttp = res.redirectTo.protocol === 'http:' || res.redirectTo.protocol === 'https:';
      if (isMain) {
        if (nextIsHttp) state.setRedirect({ status: res.status, location: res.redirectTo.href });
        else
          state.refusal = {
            status: res.status,
            refusedUrl: res.redirectTo.href,
            refusal: 'DISALLOWED_REDIRECT',
          };
        await route.abort('aborted');
        return;
      }
      // iframe documents are not followed across redirects; sub-resources are, each hop re-guarded.
      if (isDocument || !nextIsHttp || hops >= CRAWL_POLICY.maxRedirects) {
        await route.abort('blockedbyclient');
        return;
      }
      if (res.status !== 307 && res.status !== 308) {
        method = 'GET';
        body = undefined;
      }
      url = res.redirectTo;
    }
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    if (browser) await (await browser).close();
  }
}
