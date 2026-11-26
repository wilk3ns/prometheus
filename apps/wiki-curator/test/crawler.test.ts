import { describe, expect, it } from 'vitest';
import { DomainAllowlist } from '../src/crawler/allowlist.js';
import { CrawlRunner } from '../src/crawler/crawl-runner.js';
import {
  KeywordLinkSelector,
  RELEVANCE_KEYWORDS,
  scoreLink,
  type LinkSelectorPort,
} from '../src/crawler/link-selector.js';
import { runCrawlBatch, type BatchLine } from '../src/ops/crawl-batch.js';
import { capturePage, type CaptureDeps } from '../src/crawler/page-capture.js';
import { SnapshotStore } from '../src/crawler/snapshot-store.js';
import { parseSeed, SeedValidationError } from '../src/seed/seed.js';
import { fixtureAllowlistEntry } from './support/fixtures.js';
import {
  clock,
  html,
  ids,
  longText,
  MemoryBlobStore,
  MemoryRepo,
  pdf,
  ScriptedHttp,
  ScriptedRenderer,
  target,
  twoPagePdf,
} from './support/fakes.js';

const allowlist = new DomainAllowlist([
  fixtureAllowlistEntry('pw.edu.pl'),
  fixtureAllowlistEntry('elte.hu', { country_iso2: 'HU', default_fetch_mode: 'JS_CATALOG' }),
]);
const RENDERED = `<html lang="en"><body><div id="app">${longText(60)}</div></body></html>`;

function deps(
  http: ScriptedHttp,
  renderer = new ScriptedRenderer(() => ({
    kind: 'RENDERED',
    finalUrl: '',
    status: 200,
    headers: {},
    html: RENDERED,
  })),
): CaptureDeps & { renderer: ScriptedRenderer } {
  return { allowlist, http, renderer, pdf: twoPagePdf };
}

describe('[T1-G5] tier escalation (rule 2)', () => {
  it('keeps Tier 1 for an HTTP_FIRST host with >= 500 clean chars', async () => {
    const d = deps(new ScriptedHttp({ 'https://pw.edu.pl/a': (u) => html(u, `<p>${longText(40)}</p>`) }));
    const c = await capturePage(new URL('https://pw.edu.pl/a'), d);
    expect(c).toMatchObject({ kind: 'CONTENT', tier: 'TIER1_HTTP', contentKind: 'HTML' });
    expect(d.renderer.rendered).toEqual([]);
  });

  it('escalates when Tier 1 yields < 500 clean chars', async () => {
    const renderer = new ScriptedRenderer((u) => ({
      kind: 'RENDERED',
      finalUrl: u,
      status: 200,
      headers: {},
      html: RENDERED,
    }));
    const d = deps(
      new ScriptedHttp({ 'https://pw.edu.pl/spa': (u) => html(u, '<div id="app">Loading...</div>') }),
      renderer,
    );
    const c = await capturePage(new URL('https://pw.edu.pl/spa'), d);
    expect(c).toMatchObject({ kind: 'CONTENT', tier: 'TIER2_PLAYWRIGHT' });
    expect(c.kind === 'CONTENT' && c.cleanCharCount).toBeGreaterThan(1000);
    expect(renderer.rendered).toEqual(['https://pw.edu.pl/spa']);
  });

  it('escalates JS_CATALOG hosts even when Tier 1 text is long', async () => {
    const renderer = new ScriptedRenderer((u) => ({
      kind: 'RENDERED',
      finalUrl: u,
      status: 200,
      headers: {},
      html: RENDERED,
    }));
    const d = deps(
      new ScriptedHttp({ 'https://www.elte.hu/en/find': (u) => html(u, `<p>${longText(40)}</p>`) }),
      renderer,
    );
    expect(await capturePage(new URL('https://www.elte.hu/en/find'), d)).toMatchObject({
      tier: 'TIER2_PLAYWRIGHT',
    });
  });

  it('[T1-G6] never sends a PDF to Playwright, even on a JS_CATALOG host', async () => {
    const d = deps(new ScriptedHttp({ 'https://www.elte.hu/x.pdf': pdf }));
    const c = await capturePage(new URL('https://www.elte.hu/x.pdf'), d);
    expect(c).toMatchObject({ kind: 'CONTENT', contentKind: 'PDF', tier: 'TIER1_HTTP', pageCount: 2 });
    expect(c.kind === 'CONTENT' && c.cleanText).toBe('[PAGE 1]\nfirst page\n\n[PAGE 2]\nsecond page');
    expect(d.renderer.rendered).toEqual([]);
  });

  it('[T1-G7] stops on a challenge gate without escalating or retrying', async () => {
    const http = new ScriptedHttp({
      'https://pw.edu.pl/waf': (u) =>
        html(u, '<div class="cf-turnstile"></div>', 403, { 'cf-mitigated': 'challenge' }),
      'https://pw.edu.pl/shell': (u) => html(u, '<div class="h-captcha"></div>'),
    });
    const d = deps(http);
    expect(await capturePage(new URL('https://pw.edu.pl/waf'), d)).toMatchObject({
      kind: 'ERROR',
      errorCode: 'WAF_CHALLENGE_DETECTED',
      httpStatus: 403,
    });
    expect(await capturePage(new URL('https://pw.edu.pl/shell'), d)).toMatchObject({
      kind: 'ERROR',
      errorCode: 'WAF_CHALLENGE_DETECTED',
    });
    expect(d.renderer.rendered).toEqual([]);
    expect(http.requested).toEqual(['https://pw.edu.pl/waf', 'https://pw.edu.pl/shell']);
  });

  it('[T1-G4] 404/410 become MISSING_SOURCE_404, refused hops become DISALLOWED_REDIRECT', async () => {
    const http = new ScriptedHttp({
      'https://pw.edu.pl/gone': (u) => html(u, 'gone', 410),
      'https://pw.edu.pl/offsite': (u) => ({
        kind: 'HOP_REFUSED',
        requestedUrl: u,
        status: 302,
        refusedUrl: 'https://evil.example.com/',
        refusal: 'DISALLOWED_REDIRECT',
      }),
    });
    const d = deps(http);
    expect(await capturePage(new URL('https://pw.edu.pl/missing'), d)).toMatchObject({
      errorCode: 'MISSING_SOURCE_404',
      httpStatus: 404,
    });
    expect(await capturePage(new URL('https://pw.edu.pl/gone'), d)).toMatchObject({
      errorCode: 'MISSING_SOURCE_404',
      httpStatus: 410,
    });
    expect(await capturePage(new URL('https://pw.edu.pl/offsite'), d)).toMatchObject({
      kind: 'ERROR',
      errorCode: 'DISALLOWED_REDIRECT',
      httpStatus: 302,
      finalUrl: 'https://evil.example.com/',
    });
  });

  it('refuses a Tier 2 render that lands off the allowlist', async () => {
    const renderer = new ScriptedRenderer(() => ({
      kind: 'RENDERED',
      finalUrl: 'https://evil.example.com/',
      status: 200,
      headers: {},
      html: RENDERED,
    }));
    const d = deps(
      new ScriptedHttp({ 'https://pw.edu.pl/spa': (u) => html(u, '<div>Loading</div>') }),
      renderer,
    );
    expect(await capturePage(new URL('https://pw.edu.pl/spa'), d)).toMatchObject({
      kind: 'ERROR',
      errorCode: 'DISALLOWED_REDIRECT',
    });
  });
});

describe('[LOW-5] raw blob keeps the charset it was served with', () => {
  it('stores Tier 1 HTML with its original Content-Type and Tier 2 HTML as UTF-8', async () => {
    const blobs = new MemoryBlobStore();
    const store = new SnapshotStore(blobs, new MemoryRepo(), ids(), clock);
    const legacy = deps(
      new ScriptedHttp({
        'https://pw.edu.pl/cp1250': (u) =>
          html(u, `<p>${longText(40)}</p>`, 200, { 'content-type': 'text/html; charset=windows-1250' }),
      }),
    );
    const c = await capturePage(new URL('https://pw.edu.pl/cp1250'), legacy);
    if (c.kind !== 'CONTENT') throw new Error('expected content');
    expect(c.rawContentType).toBe('text/html; charset=windows-1250');
    await store.persistContent(c, null);
    expect([...blobs.types.values()]).toContain('text/html; charset=windows-1250');
    const renderer = new ScriptedRenderer((u) => ({
      kind: 'RENDERED',
      finalUrl: u,
      status: 200,
      headers: {},
      html: RENDERED,
    }));
    const t2 = await capturePage(
      new URL('https://pw.edu.pl/spa'),
      deps(new ScriptedHttp({ 'https://pw.edu.pl/spa': (u) => html(u, '<div>Loading</div>') }), renderer),
    );
    expect(t2.kind === 'CONTENT' && t2.rawContentType).toBe('text/html; charset=utf-8');
  });
});

describe('[T1-G8] snapshot store content addressing (§4)', () => {
  it('keys blobs by sha256, skips re-upload of identical bytes, but records a row per capture', async () => {
    const blobs = new MemoryBlobStore();
    const repo = new MemoryRepo();
    const store = new SnapshotStore(blobs, repo, ids(), clock);
    const d = deps(new ScriptedHttp({ 'https://pw.edu.pl/a': (u) => html(u, `<p>${longText(40)}</p>`) }));
    const c = await capturePage(new URL('https://pw.edu.pl/a'), d);
    if (c.kind !== 'CONTENT') throw new Error('expected content');
    const first = await store.persistContent(c, null);
    const second = await store.persistContent(c, null);
    expect(first).toMatchObject({ rawBlobCreated: true, textBlobCreated: true });
    expect(second).toMatchObject({
      rawBlobCreated: false,
      textBlobCreated: false,
      rawBlobRef: first.rawBlobRef,
    });
    expect(first.rawBlobRef).toMatch(/^wiki-snapshots\/raw\/[0-9a-f]{64}\.html$/);
    expect(blobs.objects.size).toBe(2);
    expect(repo.snapshots).toHaveLength(2);
    expect(repo.snapshots[0]?.clean_text_blob_ref).toMatch(/^wiki-snapshots\/text\/[0-9a-f]{64}\.txt$/);
    expect(repo.snapshots[0]?.id).not.toBe(repo.snapshots[1]?.id);
  });

  it('stores 0 bytes for error captures', async () => {
    const blobs = new MemoryBlobStore();
    const repo = new MemoryRepo();
    await new SnapshotStore(blobs, repo, ids(), clock).persistError(
      {
        kind: 'ERROR',
        tier: 'TIER1_HTTP',
        requestedUrl: 'https://pw.edu.pl/x',
        finalUrl: 'https://pw.edu.pl/x',
        httpStatus: 404,
        errorCode: 'MISSING_SOURCE_404',
      },
      null,
    );
    expect(blobs.puts).toBe(0);
    expect(repo.snapshots[0]).toMatchObject({
      content_kind: 'HTTP_ERROR',
      raw_sha256: null,
      raw_blob_ref: null,
      clean_char_count: 0,
    });
  });
});

describe('[T1-G4] BFS crawl runner (rules 4 + 5)', () => {
  const hub = `<body><div>${longText(30)}
    <a href="/pl/cennik-ds">Cennik</a><a href="/about">About us</a><a href="/doc.pdf">Decree</a>
    <a href="/logo.png">logo</a><a href="https://evil.example.com/">evil</a></div></body>`;
  const leaf = (links = '') => `<body><p>${longText(30)}</p>${links}</body>`;

  function runner(http: ScriptedHttp, selector: LinkSelectorPort = new KeywordLinkSelector()) {
    const repo = new MemoryRepo();
    const r = new CrawlRunner({
      capture: deps(http),
      snapshots: new SnapshotStore(new MemoryBlobStore(), repo, ids(), clock),
      selector,
      repo,
      clock,
    });
    return { r, repo };
  }

  it('follows only harvested allowlisted document links, best score first, within depth', async () => {
    const http = new ScriptedHttp({
      'https://pw.edu.pl/hub': (u) => html(u, hub),
      'https://pw.edu.pl/pl/cennik-ds': (u) => html(u, leaf('<a href="/deeper">deeper admission</a>')),
      'https://pw.edu.pl/about': (u) => html(u, leaf()),
      'https://pw.edu.pl/doc.pdf': pdf,
    });
    const { r, repo } = runner(http);
    const report = await r.crawl(target({ maxDepth: 1 }));
    expect(http.requested).toEqual([
      'https://pw.edu.pl/hub',
      'https://pw.edu.pl/doc.pdf', // .pdf -> 25 and 'cennik' -> 25: tie broken by URL
      'https://pw.edu.pl/pl/cennik-ds',
      'https://pw.edu.pl/about',
    ]);
    expect(report.fetchedCount).toBe(4);
    expect(http.requested).not.toContain('https://pw.edu.pl/deeper'); // depth 2 > maxDepth 1
    expect(http.requested.some((u) => u.includes('logo.png') || u.includes('evil'))).toBe(false);
    expect(repo.crawled).toHaveLength(1);
  });

  it('enforces max_pages across all attempts including 404s', async () => {
    const http = new ScriptedHttp({ 'https://pw.edu.pl/hub': (u) => html(u, hub) });
    const { r } = runner(http);
    const report = await r.crawl(target({ maxPages: 2 }));
    expect(report.fetchedCount).toBe(2);
    expect(http.requested).toHaveLength(2);
  });

  it('dedupes seeds on the normalised URL and never fetches a selector-invented URL', async () => {
    const http = new ScriptedHttp({ 'https://pw.edu.pl/hub': (u) => html(u, hub) });
    const rogue: LinkSelectorPort = {
      select: () =>
        Promise.resolve([
          { url: 'https://pw.edu.pl/guessed-admission-slug', score: 100 },
          { url: 'https://pw.edu.pl/about', score: 1 },
        ]),
    };
    const { r } = runner(http, rogue);
    await r.crawl(target({ seedUrls: ['https://pw.edu.pl/hub#x', 'https://pw.edu.pl/hub?utm_source=a'] }));
    expect(http.requested).toEqual(['https://pw.edu.pl/hub', 'https://pw.edu.pl/about']);
  });
});

describe('[T1-G4] keyword link scorer (rule 5)', () => {
  it('scores multilingual admission/fee/dorm vocabulary and PDFs; short keywords need whole tokens', () => {
    const s = (anchor: string, url: string, isPdf = false) =>
      scoreLink({ anchor_text: anchor, url, is_pdf: isPdf });
    expect(s('Rekrutacja', 'https://pw.edu.pl/rekrutacja')).toBeGreaterThan(0);
    expect(s('tariffario', 'https://polimi.it/tariffario_ING_26_27_new.pdf', true)).toBe(50);
    expect(s('Feedback', 'https://pw.edu.pl/feedback')).toBe(0);
    expect(s('Tuition fee', 'https://pw.edu.pl/x')).toBe(50);
    expect(s('a b c', 'https://pw.edu.pl/admission/apply/tuition/fee/dorm')).toBe(100);
  });

  it('[LOW-3] short keywords match their inflections (fees, dormitory) but not look-alikes (feedback)', () => {
    const s = (anchor: string) =>
      scoreLink({ anchor_text: anchor, url: 'https://pw.edu.pl/x', is_pdf: false });
    expect(s('Tuition fees 2026/27')).toBe(50);
    expect(s('Student dormitory')).toBe(25);
    expect(s('Dormitories and halls')).toBe(25);
    expect(s('Dorms')).toBe(25);
    expect(s('Send feedback')).toBe(0);
    expect(s('Feed the planet')).toBe(0);
    expect(s('NAWA recognition')).toBe(25);
    // every keyword of <= 4 chars has an explicit token rule (no silent substring matching)
    expect(RELEVANCE_KEYWORDS.filter((k) => k.length <= 4).sort()).toEqual(['dorm', 'dsu', 'fee', 'nawa']);
  });
});

describe('[HIGH-2] per-URL and per-target failure isolation', () => {
  it('a capture that throws (e.g. renderer crash) becomes CAPTURE_FAILED and the crawl continues', async () => {
    const http = new ScriptedHttp({
      'https://pw.edu.pl/spa': (u) => html(u, '<div id="app">Loading...</div>'),
      'https://pw.edu.pl/ok': (u) => html(u, `<p>${longText(40)}</p>`),
    });
    const crashing = new ScriptedRenderer(() => {
      throw new Error('Target page, context or browser has been closed');
    });
    const repo = new MemoryRepo();
    const runner = new CrawlRunner({
      capture: { allowlist, http, renderer: crashing, pdf: twoPagePdf },
      snapshots: new SnapshotStore(new MemoryBlobStore(), repo, ids(), clock),
      selector: new KeywordLinkSelector(),
      repo,
      clock,
    });
    const report = await runner.crawl(
      target({ seedUrls: ['https://pw.edu.pl/spa', 'https://pw.edu.pl/ok'] }),
    );
    expect(report.outcomes).toEqual([
      expect.objectContaining({
        url: 'https://pw.edu.pl/spa',
        status: 'NOT_FETCHED',
        reason: 'CAPTURE_FAILED',
      }),
      expect.objectContaining({ url: 'https://pw.edu.pl/ok', status: 'SNAPSHOT_STORED' }),
    ]);
    expect(repo.crawled).toHaveLength(1); // markTargetCrawled still runs
  });

  it('a PDF extractor that throws a non-PdfExtractionError is isolated too', async () => {
    const http = new ScriptedHttp({
      'https://pw.edu.pl/a.pdf': pdf,
      'https://pw.edu.pl/b': (u) => html(u, `<p>${longText(40)}</p>`),
    });
    const repo = new MemoryRepo();
    const runner = new CrawlRunner({
      capture: {
        allowlist,
        http,
        renderer: new ScriptedRenderer(() => ({ kind: 'FAILED', reason: 'RENDER_FAILED', detail: '' })),
        pdf: { extract: () => Promise.reject(new RangeError('Invalid array length')) },
      },
      snapshots: new SnapshotStore(new MemoryBlobStore(), repo, ids(), clock),
      selector: new KeywordLinkSelector(),
      repo,
      clock,
    });
    const report = await runner.crawl(
      target({ seedUrls: ['https://pw.edu.pl/a.pdf', 'https://pw.edu.pl/b'] }),
    );
    expect(report.outcomes.map((o) => o.status)).toEqual(['NOT_FETCHED', 'SNAPSHOT_STORED']);
    expect(report.outcomes[0]).toMatchObject({
      reason: 'CAPTURE_FAILED',
      detail: expect.stringContaining('RangeError'),
    });
  });

  it('crawl --all isolates a failing target and still crawls the rest', async () => {
    const lines: BatchLine[] = [];
    const t1 = target({ targetKey: 'a:x:1' });
    const t2 = target({ targetKey: 'b:x:1' });
    const t3 = target({ targetKey: 'c:x:1' });
    const summary = await runCrawlBatch(
      [t1, t2, t3],
      (t) =>
        t.targetKey === 'b:x:1'
          ? Promise.reject(new Error('connection terminated unexpectedly'))
          : Promise.resolve({
              targetKey: t.targetKey,
              startedAt: '',
              finishedAt: '',
              fetchedCount: 0,
              outcomes: [],
            }),
      (line) => lines.push(line),
    );
    expect(summary).toEqual({ crawled: 2, failed: 1 });
    expect(lines.map((l) => `${l.targetKey}:${l.status}`)).toEqual([
      'a:x:1:CRAWLED',
      'b:x:1:TARGET_FAILED',
      'c:x:1:CRAWLED',
    ]);
  });
});

describe('[T1-G8] seed validation (§5)', () => {
  const valid = {
    schema_version: 'seed-targets-v1.0',
    allowlisted_domains: [fixtureAllowlistEntry('pw.edu.pl')],
    crawl_targets: [
      {
        target_key: 'wut:bsc:2027-FALL',
        country_iso2: 'PL',
        layer_hint: 'PROGRAM',
        max_depth: 2,
        max_pages: 30,
        seed_urls: ['https://www.pw.edu.pl/'],
      },
    ],
  };

  it('accepts a valid document', () => {
    expect(parseSeed(valid).crawl_targets).toHaveLength(1);
  });

  it('rejects seed URLs outside the allowlist, bad bounds, wrong schema and duplicates', () => {
    const bad = (patch: object) => () => parseSeed({ ...valid, ...patch });
    expect(
      bad({ crawl_targets: [{ ...valid.crawl_targets[0], seed_urls: ['https://evil.example.com/'] }] }),
    ).toThrow(SeedValidationError);
    expect(bad({ crawl_targets: [{ ...valid.crawl_targets[0], max_depth: 4 }] })).toThrow(
      SeedValidationError,
    );
    expect(bad({ schema_version: 'v2' })).toThrow(SeedValidationError);
    expect(
      bad({ allowlisted_domains: [...valid.allowlisted_domains, ...valid.allowlisted_domains] }),
    ).toThrow(/duplicate/);
    expect(bad({ allowlisted_domains: [fixtureAllowlistEntry('https://pw.edu.pl')] })).toThrow(
      SeedValidationError,
    );
  });
});
