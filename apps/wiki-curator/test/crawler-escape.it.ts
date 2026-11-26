import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canaryHits, FIXTURE_ORIGIN, openHarness, type Harness } from './support/it-harness.js';

/**
 * [HIGH-1] Tier 2 must not let page JavaScript reach non-allowlisted / non-public origins through ANY
 * browser egress path. The probe page (served from the allowlisted fixture host `localhost`) targets
 * `127.0.0.1` (an IP literal: never exempt). Loopback -> loopback is the same address space, so Chromium's
 * Local Network Access checks do not apply; only our routing layer stands between the page and the canary.
 * Hits are counted by the fixture server itself (HTTP requests and WebSocket upgrades).
 */
describe('[T1-G5][HIGH-1] Tier 2 egress containment (fetch, beacon, popup, WebSocket, iframe)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await openHarness();
  });
  afterAll(async () => h?.close());

  it('the canary counter itself works for HTTP and WebSocket (positive controls)', async () => {
    const id = randomUUID();
    await fetch(`${FIXTURE_ORIGIN}/canary/${id}-http-control`);
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`${FIXTURE_ORIGIN.replace('http', 'ws')}/canary/${id}-ws-control`);
      ws.addEventListener('error', () => resolve());
      ws.addEventListener('close', () => resolve());
    });
    const hits = await canaryHits();
    expect(hits[`${id}-http-control`]).toBe(1);
    expect(hits[`${id}-ws-control`]).toBe(1);
  });

  it('records 0 canary hits for every escape path while the page itself rendered and ran its script', async () => {
    const id = randomUUID();
    const out = await h.renderer.render(new URL(`${FIXTURE_ORIGIN}/escape-probe?id=${id}`));
    expect(out.kind).toBe('RENDERED');
    expect(out.kind === 'RENDERED' && out.html).toContain(`data-probe="ran-${id}"`);
    // give any straggling popup / beacon / socket a chance to land before reading the counters
    await new Promise((r) => setTimeout(r, 1500));
    const hits = await canaryHits();
    expect(hits[`${id}-control`]).toBeGreaterThanOrEqual(1); // same-origin fetch went through our guard
    for (const path of ['fetch', 'beacon', 'popup', 'popup-same-origin', 'ws', 'ws-same-origin', 'iframe']) {
      expect(hits[`${id}-${path}`] ?? 0, `canary ${path}`).toBe(0);
    }
  });
});
