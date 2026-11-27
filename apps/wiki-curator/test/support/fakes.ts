import type { SnapshotRecord } from '@prometheus/contracts';
import type {
  BlobStorePort,
  HtmlExtractorPort,
  HttpFetcherPort,
  HttpFetchOutcome,
  JsRendererPort,
  PdfExtractorPort,
  PdfText,
  PutOutcome,
  RenderOutcome,
} from '@prometheus/infra-ports';
import { createUuidV7Generator, fixedClock, type Uuid } from '@prometheus/kernel';
import type { DomainAllowlist } from '../../src/crawler/allowlist.js';
import { extractHtml } from '../../src/crawler/html-extractor.js';
import type { CrawlTargetRow } from '../../src/persistence/wiki-repository.js';

export const clock = fixedClock(new Date('2026-11-26T12:00:00Z'));
export const ids = () => createUuidV7Generator(clock);

export class MemoryBlobStore implements BlobStorePort {
  readonly bucket = 'wiki-snapshots';
  readonly objects = new Map<string, Uint8Array>();
  readonly types = new Map<string, string>();
  puts = 0;
  putIfAbsent(key: string, bytes: Uint8Array, contentType: string): Promise<PutOutcome> {
    this.puts += 1;
    if (this.objects.has(key)) return Promise.resolve('EXISTS');
    this.objects.set(key, new Uint8Array(bytes));
    this.types.set(key, contentType);
    return Promise.resolve('CREATED');
  }
  get(key: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.objects.get(key));
  }
  listKeys(prefix: string): Promise<string[]> {
    return Promise.resolve([...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort());
  }
}

export class MemoryRepo {
  readonly snapshots: SnapshotRecord[] = [];
  readonly crawled: Uuid[] = [];
  insertSnapshot(r: SnapshotRecord): Promise<void> {
    this.snapshots.push(r);
    return Promise.resolve();
  }
  markTargetCrawled(id: Uuid): Promise<void> {
    this.crawled.push(id);
    return Promise.resolve();
  }
}

/** Scripted Tier 1: URL -> outcome. Unknown URLs 404. Records every requested URL. */
export class ScriptedHttp implements HttpFetcherPort {
  readonly requested: string[] = [];
  constructor(private readonly script: Record<string, (url: string) => HttpFetchOutcome>) {}
  fetch(url: URL): Promise<HttpFetchOutcome> {
    this.requested.push(url.href);
    const handler = this.script[url.href];
    return Promise.resolve(handler ? handler(url.href) : html(url.href, '<h1>404</h1>', 404));
  }
}

export function html(
  url: string,
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): HttpFetchOutcome {
  return {
    kind: 'RESPONSE',
    requestedUrl: url,
    finalUrl: url,
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    body: Buffer.from(body, 'utf8'),
    bodyKind: 'HTML',
  };
}

export function pdf(url: string): HttpFetchOutcome {
  return {
    kind: 'RESPONSE',
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    headers: { 'content-type': 'application/pdf' },
    body: Buffer.from('%PDF-1.4 fake'),
    bodyKind: 'PDF',
  };
}

export class ScriptedRenderer implements JsRendererPort {
  readonly rendered: string[] = [];
  constructor(private readonly respond: (url: string) => RenderOutcome) {}
  render(url: URL): Promise<RenderOutcome> {
    this.rendered.push(url.href);
    return Promise.resolve(this.respond(url.href));
  }
  blockedProxyRequests(): number {
    return 0;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

export const twoPagePdf: PdfExtractorPort = {
  extract: (): Promise<PdfText> => Promise.resolve({ pageCount: 2, pages: ['first page', 'second page'] }),
};

export const longText = (words: number): string =>
  Array.from({ length: words }, (_, i) => `admission requirement number ${i}.`).join(' ');

export function target(overrides: Partial<CrawlTargetRow> = {}): CrawlTargetRow {
  return {
    id: ids().next(),
    targetKey: 'fixture:unit:2027-FALL',
    countryIso2: 'PL',
    layerHint: 'PROGRAM',
    seedUrls: ['https://pw.edu.pl/hub'],
    maxDepth: 2,
    maxPages: 30,
    active: true,
    ...overrides,
  };
}

/** In-process HtmlExtractorPort for unit tests (production runs the same pure function in a worker). */
export function inProcessHtml(allowlist: DomainAllowlist): HtmlExtractorPort {
  return {
    extract: (h, finalUrl, contentLanguage) =>
      Promise.resolve(extractHtml(h, finalUrl, allowlist, contentLanguage)),
  };
}
