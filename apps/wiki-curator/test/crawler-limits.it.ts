import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canaryHits, FIXTURE_ORIGIN, openHarness, type Harness } from './support/it-harness.js';

/** Resolver that lies "public" at pre-check time; connect-time lookup still uses real DNS (loopback). */
const lyingPublicResolver = () => Promise.resolve(['93.184.216.34']);

describe('[T1-G4][MEDIUM] SSRF regression: connect-time DNS-rebinding defence is wired into undici', () => {
  let strict: Harness;
  let exempt: Harness;
  beforeAll(async () => {
    strict = await openHarness({ exemptFixtureAddresses: false, resolver: lyingPublicResolver });
    exempt = await openHarness();
  });
  afterAll(async () => {
    await strict?.close();
    await exempt?.close();
  });

  it('Tier 1: pre-check says public, socket resolves loopback -> BLOCKED_PRIVATE_ADDRESS with 0 server hits', async () => {
    const id = randomUUID();
    const out = await strict.http.fetch(new URL(`${FIXTURE_ORIGIN}/canary/${id}-rebind`));
    expect(out).toMatchObject({ kind: 'FAILED', reason: 'BLOCKED_PRIVATE_ADDRESS' });
    expect((await canaryHits())[`${id}-rebind`] ?? 0).toBe(0);
    // control: the same request through the exempted fixture policy does reach the server
    expect(await exempt.http.fetch(new URL(`${FIXTURE_ORIGIN}/canary/${id}-rebind-control`))).toMatchObject({
      kind: 'RESPONSE',
      status: 200,
    });
    expect((await canaryHits())[`${id}-rebind-control`]).toBe(1);
  });

  it('Tier 2: main-frame navigation goes through the same guarded client (0 hits on rebinding)', async () => {
    const id = randomUUID();
    const out = await strict.renderer.render(new URL(`${FIXTURE_ORIGIN}/canary/${id}-t2-rebind`));
    expect(out).toMatchObject({ kind: 'HOP_REFUSED', refusal: 'BLOCKED_PRIVATE_ADDRESS' });
    expect((await canaryHits())[`${id}-t2-rebind`] ?? 0).toBe(0);
  });
});

describe('[T1-G4][MEDIUM] body caps and deadlines (ENG-T1 §3 rule 2)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await openHarness();
  });
  afterAll(async () => h?.close());

  it('16 MB body with Content-Length -> BODY_TOO_LARGE', async () => {
    expect(await h.http.fetch(new URL(`${FIXTURE_ORIGIN}/big-plain`))).toMatchObject({
      kind: 'FAILED',
      reason: 'BODY_TOO_LARGE',
      detail: expect.stringContaining('content-length'),
    });
  });

  it('16 MB chunked body (no Content-Length) -> BODY_TOO_LARGE by the streaming cap', async () => {
    expect(await h.http.fetch(new URL(`${FIXTURE_ORIGIN}/big-chunked`))).toMatchObject({
      kind: 'FAILED',
      reason: 'BODY_TOO_LARGE',
      detail: 'body exceeds 15728640 bytes',
    });
  });

  it('64 MB gzip bomb (~64 KB on the wire) -> BODY_TOO_LARGE by the decoded-size cap', async () => {
    expect(await h.http.fetch(new URL(`${FIXTURE_ORIGIN}/gzip-bomb`))).toMatchObject({
      kind: 'FAILED',
      reason: 'BODY_TOO_LARGE',
      detail: 'decoded body exceeds 15728640 bytes',
    });
  });

  it('drip-fed body (1 byte / 500 ms) -> TIMEOUT at the real 15 s Tier 1 deadline', async () => {
    const started = Date.now();
    const out = await h.http.fetch(new URL(`${FIXTURE_ORIGIN}/drip`));
    const elapsed = Date.now() - started;
    expect(out).toMatchObject({ kind: 'FAILED', reason: 'TIMEOUT' });
    expect(elapsed).toBeGreaterThanOrEqual(14_500);
    expect(elapsed).toBeLessThan(17_000);
  });

  it('Tier 2 main document is capped at 15 MB too', async () => {
    expect(await h.renderer.render(new URL(`${FIXTURE_ORIGIN}/big-chunked`))).toMatchObject({
      kind: 'FAILED',
      reason: 'BODY_TOO_LARGE',
    });
  });

  it('Tier 2 networkidle wait is capped at 10 s: a page that polls forever is rendered as-is', async () => {
    const started = Date.now();
    const out = await h.renderer.render(new URL(`${FIXTURE_ORIGIN}/busy-page`));
    const elapsed = Date.now() - started;
    expect(out).toMatchObject({ kind: 'RENDERED', status: 200 });
    expect(out.kind === 'RENDERED' && out.html).toContain('Busy catalogue');
    expect(elapsed).toBeGreaterThanOrEqual(10_000);
    expect(elapsed).toBeLessThan(20_000);
  });
});

describe('[T1-G5][MEDIUM] Tier 2 overall render deadline', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await openHarness({ tier2: { renderDeadlineMs: 3_000 } });
  });
  afterAll(async () => h?.close());

  it('a main document that never finishes is abandoned at the render deadline', async () => {
    const started = Date.now();
    const out = await h.renderer.render(new URL(`${FIXTURE_ORIGIN}/drip`));
    const elapsed = Date.now() - started;
    expect(out).toMatchObject({ kind: 'FAILED', reason: 'TIMEOUT' });
    expect(elapsed).toBeLessThan(8_000);
  });
});

describe('[LOW-1 c2] the fixture exemption applies only to the crawl target own requests', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await openHarness();
  });
  afterAll(async () => h?.close());

  it('a request made on behalf of a non-exempt page cannot reach the exempt localhost fixture', async () => {
    const id = randomUUID();
    const signal = AbortSignal.timeout(10_000);
    const denied = await h.client.send({
      url: new URL(`${FIXTURE_ORIGIN}/canary/${id}-exempt-denied`),
      scope: 'ANY_PUBLIC_HOST',
      localExemption: h.client.localExemptionFor(new URL('https://www.polimi.it/en/')),
      signal,
    });
    expect(denied).toEqual({ kind: 'REFUSED', decision: 'BLOCKED_PRIVATE_ADDRESS' });
    const allowed = await h.client.send({
      url: new URL(`${FIXTURE_ORIGIN}/canary/${id}-exempt-allowed`),
      scope: 'ANY_PUBLIC_HOST',
      localExemption: h.client.localExemptionFor(new URL(`${FIXTURE_ORIGIN}/js-catalog`)),
      signal,
    });
    expect(allowed).toMatchObject({ kind: 'RESPONSE', status: 200 });
    const hits = await canaryHits();
    expect(hits[`${id}-exempt-denied`] ?? 0).toBe(0);
    expect(hits[`${id}-exempt-allowed`]).toBe(1);
  });
});

describe('[LOW-3 c2] Tier 2 per-render aggregate budgets', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await openHarness();
  });
  afterAll(async () => h?.close());

  it('a page pulling 6 x 10 MB sub-resources (each under the 15 MB cap) exceeds the 50 MB render budget', async () => {
    expect(await h.renderer.render(new URL(`${FIXTURE_ORIGIN}/budget-bytes`))).toMatchObject({
      kind: 'FAILED',
      reason: 'RENDER_BUDGET_EXCEEDED',
      detail: expect.stringContaining('byte budget'),
    });
  });

  it('a page firing 400 requests exceeds the 250-request render budget', async () => {
    expect(await h.renderer.render(new URL(`${FIXTURE_ORIGIN}/budget-count`))).toMatchObject({
      kind: 'FAILED',
      reason: 'RENDER_BUDGET_EXCEEDED',
      detail: expect.stringContaining('request budget'),
    });
  });

  it('a normal JS catalogue stays well inside both budgets', async () => {
    expect(await h.renderer.render(new URL(`${FIXTURE_ORIGIN}/js-catalog`))).toMatchObject({
      kind: 'RENDERED',
    });
  });
});
