// SSRF / egress probes for the crawler integration tests.
import dgram from 'node:dgram';
import net from 'node:net';

export const FILLER = Array.from(
  { length: 40 },
  (_, i) => `Admission requirement ${i}: applicants submit certified documents before the deadline.`,
).join(' ');

/**
 * Raw socket canary: a TCP + UDP listener that counts EVERY connection and datagram regardless of protocol
 * (HTTP, WebSocket, STUN/TURN over TCP, TLS ClientHello, QUIC). Nothing legitimate ever talks to it, so
 * tests assert that its counters do not move while a probe page renders.
 */
export function startRawCanary(port) {
  const counters = { tcp: 0, udp: 0, firstBytes: [] };
  net
    .createServer((socket) => {
      counters.tcp += 1;
      socket.once('data', (d) => {
        if (counters.firstBytes.length < 20) counters.firstBytes.push(d.subarray(0, 16).toString('hex'));
      });
      socket.on('error', () => {});
      setTimeout(() => socket.destroy(), 200);
    })
    .listen(port, '0.0.0.0');
  dgram
    .createSocket('udp4')
    .on('message', () => {
      counters.udp += 1;
    })
    .on('error', () => {})
    .bind(port, '0.0.0.0');
  return counters;
}

/**
 * A page whose script tries every browser egress path towards NON-allowlisted loopback targets
 * (127.0.0.1 while the page is served from the allowlisted fixture host). Loopback -> loopback is the same
 * address space, so Chromium's Local Network Access checks do not block any of these: only our layers can.
 *  - HTTP-level paths target `127.0.0.1:<http port>/canary/<id>-<path>` (counted per path);
 *  - socket-level paths (WebRTC STUN/TURN over UDP/TCP/TLS, WebTransport/QUIC, preconnect, raw fetch/WS,
 *    a fresh iframe realm, a dedicated worker) target the raw canary `127.0.0.1:<raw port>`.
 * `/canary/<id>-control` goes to the page's own allowlisted origin and MUST be counted.
 * `data-webrtc` records which constructors exist in the page (evidence for the init-script layer).
 */
export function escapeProbe(id, origin, rawCanaryPort) {
  const evil = `http://127.0.0.1:${new URL(origin).port}`;
  const rawHost = `127.0.0.1:${rawCanaryPort}`;
  const cfg = JSON.stringify({ evil, rawHost, id });
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>escape probe</title>
<link rel="preconnect" href="http://${rawHost}"><link rel="dns-prefetch" href="http://${rawHost}">
<link rel="preconnect" href="https://${rawHost}" crossorigin></head><body>
<div id="content"><h1>Escape probe ${id}</h1><p>${FILLER}</p></div>
<iframe src="${evil}/canary/${id}-iframe"></iframe>
<iframe src="http://${rawHost}/iframe"></iframe>
<script>
(() => {
  const { evil, rawHost, id } = ${cfg};
  const swallow = (f) => { try { const r = f(); if (r && r.catch) r.catch(() => {}); } catch (e) {} };
  const turnAll = [
    { urls: 'stun:' + rawHost },
    { urls: 'turn:' + rawHost + '?transport=udp', username: 'u', credential: 'p' },
    { urls: 'turn:' + rawHost + '?transport=tcp', username: 'u', credential: 'p' },
    { urls: 'turns:' + rawHost + '?transport=tcp', username: 'u', credential: 'p' },
  ];
  const offer = (Ctor, iceServers) => {
    const pc = new Ctor({ iceServers });
    pc.createDataChannel('probe');
    return pc.createOffer().then((o) => pc.setLocalDescription(o));
  };
  fetch('/canary/' + id + '-control').catch(() => {});
  swallow(() => fetch(evil + '/canary/' + id + '-fetch'));
  swallow(() => navigator.sendBeacon(evil + '/canary/' + id + '-beacon', 'x'));
  swallow(() => window.open(evil + '/canary/' + id + '-popup'));
  swallow(() => window.open('/canary/' + id + '-popup-same-origin'));
  swallow(() => new WebSocket(evil.replace('http', 'ws') + '/canary/' + id + '-ws'));
  swallow(() => new WebSocket(location.origin.replace('http', 'ws') + '/canary/' + id + '-ws-same-origin'));
  swallow(() => new EventSource(evil + '/canary/' + id + '-sse'));
  swallow(() => fetch('http://' + rawHost + '/raw-fetch'));
  swallow(() => new WebSocket('ws://' + rawHost + '/raw-ws'));
  swallow(() => offer(window.RTCPeerConnection, turnAll));
  swallow(() => offer(window.webkitRTCPeerConnection, turnAll));
  swallow(() => new WebTransport('https://' + rawHost + '/wt').ready);
  swallow(() => {
    const f = document.createElement('iframe');
    document.body.appendChild(f);
    return offer(f.contentWindow.RTCPeerConnection, turnAll);
  });
  swallow(() => {
    const src =
      'try { new WebTransport("https://' + rawHost + '/wt-worker").ready.catch(() => {}); } catch (e) {}' +
      'fetch("http://' + rawHost + '/worker-fetch").catch(() => {});' +
      'try { new WebSocket("ws://' + rawHost + '/worker-ws"); } catch (e) {}';
    new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  });
  const el = document.getElementById('content');
  el.setAttribute('data-probe', 'ran-' + id);
  el.setAttribute(
    'data-webrtc',
    [typeof window.RTCPeerConnection, typeof window.webkitRTCPeerConnection, typeof window.RTCDataChannel,
      typeof window.WebTransport].join('/'),
  );
  // ENG-T2 Q5: worker constructors must be absent (init scripts never run inside worker realms)
  el.setAttribute('data-workers', [typeof window.Worker, typeof window.SharedWorker].join('/'));
})();
</script></body></html>`;
}

/** Page fetching 6 x 10 MB sub-resources: each under the 15 MB per-request cap, 60 MB in total. */
export const BUDGET_BYTES_PAGE = `<!DOCTYPE html><html lang="en"><body><div id="app"><h1>Heavy page</h1><p>${FILLER}</p></div>
<script>for (let i = 0; i < 6; i++) fetch('/bytes?mb=10&i=' + i).catch(() => {});</script></body></html>`;

/** Page firing 400 small sub-resource requests. */
export const BUDGET_COUNT_PAGE = `<!DOCTYPE html><html lang="en"><body><div id="app"><h1>Chatty page</h1><p>${FILLER}</p></div>
<script>for (let i = 0; i < 400; i++) fetch('/healthz?i=' + i).catch(() => {});</script></body></html>`;
