import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canaryHits, FIXTURE_ORIGIN, openHarness, rawCanary, type Harness } from './support/it-harness.js';

const RAW_CANARY_PORT = new URL(process.env['FIXTURE_CANARY_ORIGIN'] ?? 'http://localhost:8089').port;

/**
 * [HIGH-1 c1][HIGH c2] Tier 2 must not let page JavaScript reach non-allowlisted / non-public targets
 * through ANY browser egress path. The probe page (served from the allowlisted fixture host `localhost`)
 * targets `127.0.0.1` (an IP literal: never exempt). Loopback -> loopback is the same address space, so
 * Chromium's Local Network Access checks play no part; only our layers stand in between.
 * Two independent counters on the fixture side:
 *  - HTTP canary (per path): fetch, beacon, popups, WebSockets, EventSource, iframe;
 *  - RAW canary (every TCP connection and UDP datagram, any protocol): STUN/TURN over UDP/TCP/TLS (incl.
 *    webkit-prefixed and fresh-iframe-realm constructors), WebTransport/QUIC, preconnect/dns-prefetch,
 *    raw fetch/WS, an iframe, and a dedicated worker (where init scripts do not run).
 * Control experiment (recorded in the HANDOFF): without these layers the same page produced HTTP hits on
 * every path and 14 TCP / 42 UDP raw hits; the cycle-2 renderer still produced 10 raw TCP (TURN).
 */
describe('[T1-G5][HIGH c2] Tier 2 egress containment: HTTP, WebSocket, WebRTC TURN/STUN, WebTransport, workers', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await openHarness();
  });
  afterAll(async () => h?.close());

  it('the canary counters themselves work for HTTP, WebSocket, raw TCP and raw UDP (positive controls)', async () => {
    const id = randomUUID();
    await fetch(`${FIXTURE_ORIGIN}/canary/${id}-http-control`);
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(`${FIXTURE_ORIGIN.replace('http', 'ws')}/canary/${id}-ws-control`);
      ws.addEventListener('error', () => resolve());
      ws.addEventListener('close', () => resolve());
    });
    const before = await rawCanary();
    const { connect } = await import('node:net');
    await new Promise<void>((resolve) => {
      const s = connect(Number(RAW_CANARY_PORT), '127.0.0.1', () => s.end('probe'));
      s.on('close', () => resolve());
      s.on('error', () => resolve());
    });
    const dgram = await import('node:dgram');
    await new Promise<void>((resolve) => {
      const u = dgram.createSocket('udp4');
      u.send('probe', Number(RAW_CANARY_PORT), '127.0.0.1', () => {
        u.close();
        resolve();
      });
    });
    await new Promise((r) => setTimeout(r, 300));
    const after = await rawCanary();
    const hits = await canaryHits();
    expect(hits[`${id}-http-control`]).toBe(1);
    expect(hits[`${id}-ws-control`]).toBe(1);
    expect(after.tcp - before.tcp).toBe(1);
    expect(after.udp - before.udp).toBe(1);
  });

  it('records 0 HTTP hits and 0 raw TCP/UDP connections for every escape path; page JS ran', async () => {
    const id = randomUUID();
    const before = await rawCanary();
    const out = await h.renderer.render(
      new URL(`${FIXTURE_ORIGIN}/escape-probe?id=${id}&raw=${RAW_CANARY_PORT}`),
    );
    expect(out.kind).toBe('RENDERED');
    const html = out.kind === 'RENDERED' ? out.html : '';
    expect(html).toContain(`data-probe="ran-${id}"`);
    // layer 2 evidence: the socket-capable constructors were absent in the page realm
    expect(html).toContain('data-webrtc="undefined/undefined/undefined/undefined"');
    // let straggling ICE gathering / TURN allocation / worker sockets / popups land before reading
    await new Promise((r) => setTimeout(r, 4000));
    const after = await rawCanary();
    const hits = await canaryHits();
    expect(hits[`${id}-control`]).toBeGreaterThanOrEqual(1); // same-origin fetch went through our guard
    for (const path of [
      'fetch',
      'beacon',
      'popup',
      'popup-same-origin',
      'ws',
      'ws-same-origin',
      'sse',
      'iframe',
    ]) {
      expect(hits[`${id}-${path}`] ?? 0, `HTTP canary ${path}`).toBe(0);
    }
    expect(after.tcp - before.tcp, 'raw TCP connections to the canary').toBe(0);
    expect(after.udp - before.udp, 'raw UDP datagrams to the canary').toBe(0);
  });
});
