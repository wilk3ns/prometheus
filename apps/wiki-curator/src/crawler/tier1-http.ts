import type { NotFetchedReason } from '@prometheus/contracts';
import type { HttpFetcherPort, HttpFetchOutcome, SniffedBodyKind } from '@prometheus/infra-ports';
import type { GuardedHttpClient } from './guarded-http.js';
import { CRAWL_POLICY } from './policy.js';

/**
 * Tier 1 fetcher (ENG-T1 §3 rules 1 + 2). Follows redirects hop by hop through the GuardedHttpClient, so the
 * allowlist + address policy runs before the first request AND before every hop (and again at socket
 * connect time). A single deadline (the client's timeout, 15 s by default) spans all hops and the body.
 */

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

const ACCEPT = 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.5';

export class UndiciHttpFetcher implements HttpFetcherPort {
  constructor(private readonly client: GuardedHttpClient) {}

  async fetch(url: URL): Promise<HttpFetchOutcome> {
    const requestedUrl = url.href;
    const signal = AbortSignal.timeout(this.client.timeoutMs);
    let current = url;
    let previousStatus: number | undefined;

    for (let hop = 0; ; hop += 1) {
      const res = await this.client.send({
        url: current,
        scope: 'ALLOWLISTED',
        signal,
        headers: { accept: ACCEPT },
        refuseUnreadableTypes: true,
      });

      if (res.kind === 'FAILED') {
        const detail = res.reason === 'TIMEOUT' ? `exceeded ${this.client.timeoutMs} ms` : res.detail;
        return { kind: 'FAILED', requestedUrl, reason: res.reason, detail };
      }
      if (res.kind === 'REFUSED') {
        if (res.decision === 'DNS_FAILURE') {
          return {
            kind: 'FAILED',
            requestedUrl,
            reason: 'NETWORK_ERROR',
            detail: `unresolvable: ${current.host}`,
          };
        }
        if (previousStatus === undefined) {
          const reason: NotFetchedReason =
            res.decision === 'DISALLOWED_HOST' ? 'DISALLOWED_HOST' : 'BLOCKED_PRIVATE_ADDRESS';
          return { kind: 'FAILED', requestedUrl, reason, detail: `${res.decision}: ${current.host}` };
        }
        return {
          kind: 'HOP_REFUSED',
          requestedUrl,
          status: previousStatus,
          refusedUrl: current.href,
          refusal: res.decision === 'DISALLOWED_HOST' ? 'DISALLOWED_REDIRECT' : 'BLOCKED_PRIVATE_ADDRESS',
        };
      }

      if (res.redirectTo !== undefined) {
        if (hop + 1 > CRAWL_POLICY.maxRedirects) {
          return {
            kind: 'FAILED',
            requestedUrl,
            reason: 'TOO_MANY_REDIRECTS',
            detail: `> ${CRAWL_POLICY.maxRedirects} hops`,
          };
        }
        if (res.redirectTo.protocol !== 'http:' && res.redirectTo.protocol !== 'https:') {
          return {
            kind: 'HOP_REFUSED',
            requestedUrl,
            status: res.status,
            refusedUrl: res.redirectTo.href,
            refusal: 'DISALLOWED_REDIRECT',
          };
        }
        previousStatus = res.status;
        current = res.redirectTo;
        continue;
      }

      return {
        kind: 'RESPONSE',
        requestedUrl,
        finalUrl: current.href,
        status: res.status,
        headers: res.headers,
        body: new Uint8Array(res.body.buffer, res.body.byteOffset, res.body.byteLength),
        bodyKind: sniffBody(res.headers['content-type'], res.body),
      };
    }
  }
}
