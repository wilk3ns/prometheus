import type { HopRefusal, JsRendererPort, RenderOutcome } from '@prometheus/infra-ports';
import {
  chromium,
  errors,
  type Browser,
  type BrowserContext,
  type Frame,
  type Request,
  type Route,
} from 'playwright';
import { CRAWL_POLICY } from './policy.js';
import type { RequestGuard } from './request-guard.js';

/**
 * Tier 2 renderer (ENG-T1 §3 rule 2) for JS/AJAX catalogs. Plain headless Chromium with the same honest
 * User-Agent as Tier 1: NO stealth/evasion plugins, NO CAPTCHA solving (challenge pages are detected and
 * recorded upstream, never bypassed).
 *
 * Network policy inside the browser:
 *  - image/media/font requests and analytics trackers are aborted (keeps renders < 5 s);
 *  - every main-frame navigation is checked against the official allowlist + public-address policy, then
 *    fetched with `maxRedirects: 0`. A redirect is never handed to Chromium (it would follow it internally
 *    without re-entering the route handler); instead the hop is aborted, recorded, and `render()` navigates
 *    to the Location itself, so each hop is checked BEFORE any request to it is sent;
 *  - other sub-resources (scripts, XHR, CSS, iframes) may come from third-party CDNs but never from
 *    loopback/private/link-local addresses.
 */

const BLOCKED_RESOURCE_TYPES: ReadonlySet<string> = new Set(['image', 'media', 'font']);
const TRACKER_HOST =
  /(^|\.)(google-analytics\.com|googletagmanager\.com|doubleclick\.net|facebook\.(com|net)|hotjar\.(com|io))$/i;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export interface Tier2Options {
  readonly userAgent: string;
}

/** Mutable per-render state shared with the route handler. */
class NavigationState {
  /** Status of the redirect that led to the navigation currently in flight (0 for the first hop). */
  viaStatus = 0;
  redirect: { status: number; location: string } | undefined;
  refusal: { status: number; refusedUrl: string; refusal: HopRefusal } | undefined;

  /** Returns and clears the redirect recorded by the route handler for the last navigation. */
  takeRedirect(): { status: number; location: string } | undefined {
    const r = this.redirect;
    this.redirect = undefined;
    return r;
  }

  refused(): RenderOutcome | undefined {
    return this.refusal ? { kind: 'HOP_REFUSED', ...this.refusal } : undefined;
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

export class PlaywrightJsRenderer implements JsRendererPort {
  private browser: Promise<Browser> | undefined;

  constructor(
    private readonly guard: RequestGuard,
    private readonly options: Tier2Options,
  ) {}

  private launch(): Promise<Browser> {
    this.browser ??= chromium.launch({ headless: true });
    return this.browser;
  }

  async render(url: URL): Promise<RenderOutcome> {
    let context: BrowserContext | undefined;
    const state = new NavigationState();
    try {
      const browser = await this.launch();
      context = await browser.newContext({
        userAgent: this.options.userAgent,
        locale: 'en-US',
        extraHTTPHeaders: { 'accept-language': CRAWL_POLICY.acceptLanguage },
        serviceWorkers: 'block',
        acceptDownloads: false,
      });
      const page = await context.newPage();
      await page.route('**/*', (route, request) => this.handle(route, request, page.mainFrame(), state));

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
        await page.waitForLoadState('networkidle', { timeout: CRAWL_POLICY.tier2NetworkIdleCapMs });
      } catch (error) {
        // networkidle is capped by contract: a page that keeps polling is rendered as-is after 10 s.
        if (!(error instanceof errors.TimeoutError)) throw error;
      }
      const refusedLate = state.refused();
      if (refusedLate) return refusedLate;

      const html: unknown = await page.evaluate('document.documentElement.outerHTML');
      if (typeof html !== 'string')
        return { kind: 'FAILED', reason: 'RENDER_FAILED', detail: 'outerHTML not a string' };
      return {
        kind: 'RENDERED',
        finalUrl: page.url(),
        status: response.status(),
        headers: await response.allHeaders(),
        html,
      };
    } finally {
      await context?.close();
    }
  }

  private async handle(
    route: Route,
    request: Request,
    mainFrame: Frame,
    state: NavigationState,
  ): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      await route.abort('blockedbyclient');
      return;
    }
    if (url.protocol === 'data:' || url.protocol === 'blob:') {
      await route.continue();
      return;
    }
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      BLOCKED_RESOURCE_TYPES.has(request.resourceType()) ||
      TRACKER_HOST.test(url.hostname)
    ) {
      await route.abort('blockedbyclient');
      return;
    }

    if (!(request.isNavigationRequest() && request.frame() === mainFrame)) {
      if ((await this.guard.checkAddressOnly(url)) === 'BLOCKED_PRIVATE_ADDRESS') {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
      return;
    }

    const decision = await this.guard.check(url);
    if (decision !== 'OK') {
      state.refusal = {
        status: state.viaStatus,
        refusedUrl: url.href,
        refusal: decision === 'BLOCKED_PRIVATE_ADDRESS' ? 'BLOCKED_PRIVATE_ADDRESS' : 'DISALLOWED_REDIRECT',
      };
      await route.abort('blockedbyclient');
      return;
    }
    const response = await route.fetch({ maxRedirects: 0, timeout: CRAWL_POLICY.tier2NavigationTimeoutMs });
    const location = response.headers()['location'];
    if (REDIRECT_STATUSES.has(response.status()) && location !== undefined) {
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        await route.abort('failed');
        return;
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        state.refusal = { status: response.status(), refusedUrl: next.href, refusal: 'DISALLOWED_REDIRECT' };
      } else {
        state.redirect = { status: response.status(), location: next.href };
      }
      await route.abort('aborted');
      return;
    }
    await route.fulfill({ response });
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = undefined;
    if (browser) await (await browser).close();
  }
}
