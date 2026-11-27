/**
 * Tier 2 browser hardening shared by the renderer (ENG-T1 §3 rules 1-2). Three independent layers keep
 * Chromium from opening sockets outside our guarded HTTP client:
 *  1. `context.route` / `routeWebSocket` (tier2-playwright.ts): every HTTP(S) request is fulfilled by us,
 *     every WebSocket is closed before connecting;
 *  2. NO_SOCKET_APIS_INIT_SCRIPT: removes the socket-capable APIs that `route` can never see (WebRTC
 *     STUN/TURN, WebTransport/QUIC, WebSocketStream) from every frame before page scripts run;
 *  3. launch flags + a fail-closed proxy (EgressBlackhole): anything that still dials out (e.g. from a
 *     worker, where init scripts do not run) is sent to a local black hole; QUIC and non-proxied UDP are
 *     disabled so WebRTC/WebTransport cannot fall back to direct UDP.
 */

/**
 * Globals removed from every window realm (main frame, iframes, about:blank children). Worker constructors
 * are removed too (ENG-T2 §0 Q5): init scripts never run inside worker realms, so layers 1-2 cannot hold
 * there and a page must not be able to create one at all. Service workers are additionally blocked at the
 * context level (`serviceWorkers: 'block'`); layer 3 stays the backstop for any realm we missed.
 */
export const REMOVED_SOCKET_APIS: readonly string[] = [
  'Worker',
  'SharedWorker',
  'ServiceWorker',
  'ServiceWorkerContainer',
  'ServiceWorkerRegistration',
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'RTCDataChannel',
  'RTCIceTransport',
  'RTCIceCandidate',
  'RTCSctpTransport',
  'RTCDtlsTransport',
  'RTCRtpSender',
  'RTCRtpReceiver',
  'RTCRtpTransceiver',
  'RTCSessionDescription',
  'RTCCertificate',
  'RTCRtpScriptTransform',
  'WebTransport',
  'WebTransportError',
  'WebSocketStream',
];

/**
 * Runs before any page script in every frame. Each API is replaced by a non-configurable, non-writable
 * `undefined`, so page code can neither call nor restore it (a fresh iframe realm gets the same script).
 */
export const NO_SOCKET_APIS_INIT_SCRIPT = `(() => {
  const names = ${JSON.stringify(REMOVED_SOCKET_APIS)};
  for (const name of names) {
    try {
      Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false, enumerable: false });
    } catch (e) {}
  }
})();`;

/** Chromium switches: no direct UDP for WebRTC, no QUIC (WebTransport / HTTP3), no DNS prefetch. */
export const HARDENED_CHROMIUM_ARGS: readonly string[] = [
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--disable-quic',
  '--dns-prefetch-disable',
  '--disable-background-networking',
];

/**
 * Proxy settings for the fail-closed backstop. `<-loopback>` removes Chromium's implicit proxy bypass for
 * localhost / 127.0.0.1 / [::1], so loopback targets are forced through the black hole too.
 */
export function blackholeProxy(port: number): { server: string; bypass: string } {
  return { server: `http://127.0.0.1:${port}`, bypass: '<-loopback>' };
}
