import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import type { NotFetchedReason } from '@prometheus/contracts';
import { Agent, request, type Dispatcher } from 'undici';
import type { LocalExemption } from './address-policy.js';
import { CRAWL_POLICY } from './policy.js';
import { BLOCKED_ADDRESS_ERROR_CODE, type GuardDecision, type RequestGuard } from './request-guard.js';

/**
 * The crawler's only network egress (ENG-T1 §3 rules 1 + 2). One call = one guarded HTTP hop:
 *  1. RequestGuard pre-check: allowlist (scope ALLOWLISTED) and resolved-address policy;
 *  2. undici socket `lookup` re-applies the address policy at connect time (DNS-rebinding defence);
 *  3. body streamed with a hard cap (default 15 MB) on raw AND decompressed bytes;
 *  4. aborted by the caller's deadline signal (Tier 1: 15 s over all hops; Tier 2: the render deadline).
 * Redirects are never followed here; the caller decides per hop. Tier 1 and every Tier 2 browser request
 * (documents and sub-resources alike) go through this client, so Chromium itself never opens a connection.
 */

export type HopScope = 'ALLOWLISTED' | 'ANY_PUBLIC_HOST';

export interface HopRequest {
  readonly url: URL;
  readonly scope: HopScope;
  /** Whether this request may use the local fixture exemption (see address-policy.ts LocalExemption). */
  readonly localExemption: LocalExemption;
  readonly signal: AbortSignal;
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Uint8Array | undefined;
  /** Refuse 2xx media/archive/office types before reading their body (Tier 1 documents). */
  readonly refuseUnreadableTypes?: boolean;
}

export type HopResult =
  | {
      readonly kind: 'RESPONSE';
      readonly status: number;
      /** Lower-cased names. `content-encoding`/`content-length` describe the wire, not `body`. */
      readonly headers: Readonly<Record<string, string>>;
      /** Decoded body (empty for redirects). */
      readonly body: Buffer;
      /** Set for 301/302/303/307/308 with a parseable Location (any scheme; the caller vets it). */
      readonly redirectTo: URL | undefined;
    }
  | { readonly kind: 'REFUSED'; readonly decision: Exclude<GuardDecision, 'OK'> }
  | { readonly kind: 'FAILED'; readonly reason: NotFetchedReason; readonly detail: string };

export interface GuardedHttpOptions {
  readonly userAgent: string;
  /** Per-hop socket/header/body idle timeouts; callers pass their own overall deadline signal. */
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

const UNREADABLE_TYPES =
  /^(image|audio|video|font)\/|^application\/(zip|x-rar-compressed|x-7z-compressed|vnd\.ms-|vnd\.openxmlformats)/i;

/** Request headers never forwarded from a browser request (hop-by-hop, framing, or set by us). */
const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'connection',
  'keep-alive',
  'content-length',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'accept-encoding',
  'user-agent',
]);

class BodyTooLargeError extends Error {
  override readonly name = 'BodyTooLargeError';
}

function headerMap(headers: Dispatcher.ResponseData['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

function hasCode(error: unknown, code: string): boolean {
  for (let e: unknown = error, depth = 0; e !== null && typeof e === 'object' && depth < 8; depth += 1) {
    if ('code' in e && e.code === code) return true;
    e = 'cause' in e ? e.cause : undefined;
  }
  return false;
}

async function readCapped(body: Dispatcher.ResponseData['body'], limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > limit) {
      body.destroy();
      throw new BodyTooLargeError(`body exceeds ${limit} bytes`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function decode(raw: Buffer, encoding: string | undefined, limit: number): Buffer {
  const enc = (encoding ?? 'identity').trim().toLowerCase();
  const opts = { maxOutputLength: limit };
  try {
    if (enc === 'identity' || enc === '') return raw;
    if (enc === 'gzip' || enc === 'x-gzip') return gunzipSync(raw, opts);
    if (enc === 'br') return brotliDecompressSync(raw, opts);
    if (enc === 'deflate') return inflateSync(raw, opts);
  } catch (error) {
    if (error instanceof RangeError) throw new BodyTooLargeError(`decoded body exceeds ${limit} bytes`);
    throw error;
  }
  return raw; // unknown coding: keep bytes as served; sniffing will classify them as OTHER
}

export class GuardedHttpClient {
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
  /** One dispatcher per exemption mode: the connect-time lookup must apply the same rule as the pre-check. */
  private readonly dispatchers: Readonly<Record<LocalExemption, Agent>>;

  constructor(
    private readonly guard: RequestGuard,
    private readonly options: GuardedHttpOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? CRAWL_POLICY.tier1TimeoutMs;
    this.maxBodyBytes = options.maxBodyBytes ?? CRAWL_POLICY.maxBodyBytes;
    const agent = (exemption: LocalExemption): Agent =>
      new Agent({
        connect: { lookup: guard.connectLookup(exemption), timeout: this.timeoutMs },
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      });
    this.dispatchers = { ALLOWED: agent('ALLOWED'), DENIED: agent('DENIED') };
  }

  private classify(error: unknown): HopResult {
    if (error instanceof BodyTooLargeError)
      return { kind: 'FAILED', reason: 'BODY_TOO_LARGE', detail: error.message };
    if (hasCode(error, BLOCKED_ADDRESS_ERROR_CODE))
      return { kind: 'REFUSED', decision: 'BLOCKED_PRIVATE_ADDRESS' };
    const name = error instanceof Error ? error.name : '';
    if (
      name === 'TimeoutError' ||
      name === 'AbortError' ||
      hasCode(error, 'UND_ERR_HEADERS_TIMEOUT') ||
      hasCode(error, 'UND_ERR_BODY_TIMEOUT') ||
      hasCode(error, 'UND_ERR_CONNECT_TIMEOUT')
    ) {
      return { kind: 'FAILED', reason: 'TIMEOUT', detail: 'deadline exceeded' };
    }
    return {
      kind: 'FAILED',
      reason: 'NETWORK_ERROR',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  async send(req: HopRequest): Promise<HopResult> {
    const decision =
      req.scope === 'ALLOWLISTED'
        ? await this.guard.check(req.url, req.localExemption)
        : await this.guard.checkAddressOnly(req.url, req.localExemption);
    if (decision !== 'OK') return { kind: 'REFUSED', decision };

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers ?? {})) {
      const lower = name.toLowerCase();
      if (!DROPPED_REQUEST_HEADERS.has(lower) && !lower.startsWith(':')) headers[lower] = value;
    }
    headers['user-agent'] = this.options.userAgent;
    headers['accept-language'] ??= CRAWL_POLICY.acceptLanguage;
    headers['accept-encoding'] = 'gzip, deflate, br';

    let res: Dispatcher.ResponseData;
    try {
      res = await request(req.url, {
        method: req.method ?? 'GET',
        dispatcher: this.dispatchers[req.localExemption],
        signal: req.signal,
        headers,
        ...(req.body !== undefined && req.body.byteLength > 0 ? { body: Buffer.from(req.body) } : {}),
      });
    } catch (error) {
      return this.classify(error);
    }

    try {
      const resHeaders = headerMap(res.headers);
      const location = resHeaders['location'];
      if (REDIRECT_STATUSES.has(res.statusCode) && location !== undefined) {
        await res.body.dump();
        let redirectTo: URL;
        try {
          redirectTo = new URL(location, req.url);
        } catch {
          return { kind: 'FAILED', reason: 'NETWORK_ERROR', detail: 'malformed Location header' };
        }
        return {
          kind: 'RESPONSE',
          status: res.statusCode,
          headers: resHeaders,
          body: Buffer.alloc(0),
          redirectTo,
        };
      }
      const contentType = resHeaders['content-type'] ?? '';
      if (req.refuseUnreadableTypes === true && res.statusCode < 300 && UNREADABLE_TYPES.test(contentType)) {
        res.body.destroy();
        return { kind: 'FAILED', reason: 'UNSUPPORTED_CONTENT_TYPE', detail: contentType };
      }
      const declared = Number(resHeaders['content-length'] ?? '0');
      if (declared > this.maxBodyBytes) {
        res.body.destroy();
        return { kind: 'FAILED', reason: 'BODY_TOO_LARGE', detail: `content-length ${declared}` };
      }
      const body = decode(
        await readCapped(res.body, this.maxBodyBytes),
        resHeaders['content-encoding'],
        this.maxBodyBytes,
      );
      return { kind: 'RESPONSE', status: res.statusCode, headers: resHeaders, body, redirectTo: undefined };
    } catch (error) {
      res.body.destroy();
      return this.classify(error);
    }
  }

  /**
   * Exemption for requests made on behalf of a page at `pageUrl`: ALLOWED only when that page's own host is a
   * configured local fixture host (the crawl target itself), DENIED for every other page.
   */
  localExemptionFor(pageUrl: URL): LocalExemption {
    return this.guard.isExemptHost(pageUrl.hostname) ? 'ALLOWED' : 'DENIED';
  }

  async close(): Promise<void> {
    await Promise.all([this.dispatchers.ALLOWED.close(), this.dispatchers.DENIED.close()]);
  }
}
