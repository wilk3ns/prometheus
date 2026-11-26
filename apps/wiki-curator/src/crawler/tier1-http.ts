import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import type { NotFetchedReason } from '@prometheus/contracts';
import type { HttpFetcherPort, HttpFetchOutcome, SniffedBodyKind } from '@prometheus/infra-ports';
import { Agent, request, type Dispatcher } from 'undici';
import { CRAWL_POLICY } from './policy.js';
import { BLOCKED_ADDRESS_ERROR_CODE, type RequestGuard } from './request-guard.js';

/**
 * Tier 1 fetcher (ENG-T1 §3 rules 1 + 2). Redirects are followed manually so the RequestGuard (allowlist +
 * public-address check) runs before the first request AND before every hop; the socket-level lookup
 * re-checks resolved addresses at connect time. Bodies are streamed with a hard 15 MB cap (also applied to
 * decompressed output) and a single 15 s budget spans all hops.
 */

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** 2xx types that can never become an HTML/PDF snapshot: refused before reading the body. */
const UNREADABLE_TYPES =
  /^(image|audio|video|font)\/|^application\/(zip|x-rar-compressed|x-7z-compressed|vnd\.ms-|vnd\.openxmlformats)/i;

export interface Tier1Options {
  readonly userAgent: string;
}

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

function classifyError(error: unknown): { reason: NotFetchedReason; detail: string } {
  if (error instanceof BodyTooLargeError) return { reason: 'BODY_TOO_LARGE', detail: error.message };
  if (hasCode(error, BLOCKED_ADDRESS_ERROR_CODE)) {
    return { reason: 'BLOCKED_PRIVATE_ADDRESS', detail: 'resolved to a non-public address at connect time' };
  }
  const name = error instanceof Error ? error.name : '';
  if (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    hasCode(error, 'UND_ERR_HEADERS_TIMEOUT') ||
    hasCode(error, 'UND_ERR_BODY_TIMEOUT') ||
    hasCode(error, 'UND_ERR_CONNECT_TIMEOUT')
  ) {
    return { reason: 'TIMEOUT', detail: `exceeded ${CRAWL_POLICY.tier1TimeoutMs} ms` };
  }
  return { reason: 'NETWORK_ERROR', detail: error instanceof Error ? error.message : String(error) };
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

function decode(raw: Buffer, encoding: string | undefined): Buffer {
  const enc = (encoding ?? 'identity').trim().toLowerCase();
  const opts = { maxOutputLength: CRAWL_POLICY.maxBodyBytes };
  try {
    if (enc === 'identity' || enc === '') return raw;
    if (enc === 'gzip' || enc === 'x-gzip') return gunzipSync(raw, opts);
    if (enc === 'br') return brotliDecompressSync(raw, opts);
    if (enc === 'deflate') return inflateSync(raw, opts);
  } catch (error) {
    if (error instanceof RangeError)
      throw new BodyTooLargeError(`decoded body exceeds ${opts.maxOutputLength} bytes`);
    throw error;
  }
  return raw; // unknown coding: keep bytes as served; sniffing will classify them as OTHER
}

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

export function sniffBody(contentType: string | undefined, body: Uint8Array): SniffedBodyKind {
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const head = Buffer.from(body.subarray(0, 1024));
  if (type === 'application/pdf' || head.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) return 'PDF';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'HTML';
  if (type === '' || type === 'application/octet-stream' || type === 'text/plain') {
    const bomless = head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? head.subarray(3) : head;
    const start = bomless.toString('latin1').trimStart().slice(0, 256).toLowerCase();
    if (
      start.startsWith('<!doctype html') ||
      start.startsWith('<html') ||
      /^<(head|body|div|p|table)\b/.test(start)
    ) {
      return 'HTML';
    }
  }
  return 'OTHER';
}

export class UndiciHttpFetcher implements HttpFetcherPort {
  private readonly dispatcher: Agent;

  constructor(
    private readonly guard: RequestGuard,
    private readonly options: Tier1Options,
  ) {
    this.dispatcher = new Agent({
      connect: { lookup: guard.connectLookup, timeout: CRAWL_POLICY.tier1TimeoutMs },
      headersTimeout: CRAWL_POLICY.tier1TimeoutMs,
      bodyTimeout: CRAWL_POLICY.tier1TimeoutMs,
    });
  }

  async fetch(url: URL): Promise<HttpFetchOutcome> {
    const requestedUrl = url.href;
    const deadline = AbortSignal.timeout(CRAWL_POLICY.tier1TimeoutMs);
    let current = url;
    let previousStatus: number | undefined;

    for (let hop = 0; ; hop += 1) {
      const decision = await this.guard.check(current);
      if (decision !== 'OK') {
        if (previousStatus === undefined) {
          const reason: NotFetchedReason =
            decision === 'DISALLOWED_HOST'
              ? 'DISALLOWED_HOST'
              : decision === 'DNS_FAILURE'
                ? 'NETWORK_ERROR'
                : 'BLOCKED_PRIVATE_ADDRESS';
          return { kind: 'FAILED', requestedUrl, reason, detail: `${decision}: ${current.host}` };
        }
        if (decision === 'DNS_FAILURE') {
          return {
            kind: 'FAILED',
            requestedUrl,
            reason: 'NETWORK_ERROR',
            detail: `redirect target unresolvable: ${current.host}`,
          };
        }
        return {
          kind: 'HOP_REFUSED',
          requestedUrl,
          status: previousStatus,
          refusedUrl: current.href,
          refusal: decision === 'DISALLOWED_HOST' ? 'DISALLOWED_REDIRECT' : 'BLOCKED_PRIVATE_ADDRESS',
        };
      }

      let res: Dispatcher.ResponseData;
      try {
        res = await request(current, {
          method: 'GET',
          dispatcher: this.dispatcher,
          signal: deadline,
          headers: {
            'user-agent': this.options.userAgent,
            'accept-language': CRAWL_POLICY.acceptLanguage,
            accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5',
            'accept-encoding': 'gzip, deflate, br',
          },
        });
      } catch (error) {
        const { reason, detail } = classifyError(error);
        if (reason === 'BLOCKED_PRIVATE_ADDRESS' && previousStatus !== undefined) {
          return {
            kind: 'HOP_REFUSED',
            requestedUrl,
            status: previousStatus,
            refusedUrl: current.href,
            refusal: 'BLOCKED_PRIVATE_ADDRESS',
          };
        }
        return { kind: 'FAILED', requestedUrl, reason, detail };
      }

      const headers = headerMap(res.headers);
      const location = headers['location'];
      if (REDIRECT_STATUSES.has(res.statusCode) && location !== undefined) {
        await res.body.dump();
        if (hop + 1 > CRAWL_POLICY.maxRedirects) {
          return {
            kind: 'FAILED',
            requestedUrl,
            reason: 'TOO_MANY_REDIRECTS',
            detail: `> ${CRAWL_POLICY.maxRedirects} hops`,
          };
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return {
            kind: 'FAILED',
            requestedUrl,
            reason: 'NETWORK_ERROR',
            detail: 'malformed Location header',
          };
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') {
          return {
            kind: 'HOP_REFUSED',
            requestedUrl,
            status: res.statusCode,
            refusedUrl: next.href,
            refusal: 'DISALLOWED_REDIRECT',
          };
        }
        previousStatus = res.statusCode;
        current = next;
        continue;
      }

      const contentType = headers['content-type'];
      if (res.statusCode < 300 && UNREADABLE_TYPES.test(contentType ?? '')) {
        res.body.destroy();
        return {
          kind: 'FAILED',
          requestedUrl,
          reason: 'UNSUPPORTED_CONTENT_TYPE',
          detail: contentType ?? '',
        };
      }
      const declared = Number(headers['content-length'] ?? '0');
      if (declared > CRAWL_POLICY.maxBodyBytes) {
        res.body.destroy();
        return {
          kind: 'FAILED',
          requestedUrl,
          reason: 'BODY_TOO_LARGE',
          detail: `content-length ${declared}`,
        };
      }

      let body: Buffer;
      try {
        body = decode(await readCapped(res.body, CRAWL_POLICY.maxBodyBytes), headers['content-encoding']);
      } catch (error) {
        const { reason, detail } = classifyError(error);
        return { kind: 'FAILED', requestedUrl, reason, detail };
      }
      return {
        kind: 'RESPONSE',
        requestedUrl,
        finalUrl: current.href,
        status: res.statusCode,
        headers,
        body: new Uint8Array(body.buffer, body.byteOffset, body.byteLength),
        bodyKind: sniffBody(contentType, body),
      };
    }
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}
