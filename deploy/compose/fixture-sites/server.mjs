// Deterministic fixture web server for crawler integration tests. Dependency-free (node:http only).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { BUDGET_BYTES_PAGE, BUDGET_COUNT_PAGE, escapeProbe, FILLER, startRawCanary } from './probes.mjs';

const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const port = Number(process.env.PORT ?? 8088);
const MB = 1024 * 1024;

const staticRoutes = {
  '/hub': ['hub.html', 'text/html; charset=utf-8'],
  '/pl/cennik-ds': ['pl/cennik-ds.html', 'text/html; charset=utf-8'],
  '/js-catalog': ['js-catalog.html', 'text/html; charset=utf-8'],
  '/api/catalog.json': ['api/catalog.json', 'application/json'],
  '/sample.pdf': ['sample.pdf', 'application/pdf'],
  // Same PDF bytes behind an opaque URL and generic content type: exercises %PDF- magic-byte sniffing.
  '/download': ['sample.pdf', 'application/octet-stream'],
};

const WAF_PAGE = `<!DOCTYPE html><html lang="en"><head><title>Just a moment...</title></head><body>
<div class="main-wrapper"><h1>Verifying you are human. This may take a few seconds.</h1>
<div class="cf-turnstile" data-sitekey="0x4AAAAAAAFIXTURE"></div>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=fixture"></script>
</div></body></html>`;

// --- SSRF canaries: every request / WebSocket upgrade to /canary/<id> is counted; tests read /canary-hits.
const canaryHits = new Map();
function hitCanary(key) {
  canaryHits.set(key, (canaryHits.get(key) ?? 0) + 1);
}

const rawCanary = startRawCanary(Number(process.env.RAW_CANARY_PORT ?? 8089));

/** A page that never reaches networkidle (polls every 200 ms): exercises the 10 s networkidle cap. */
const BUSY_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>busy</title></head><body>
<div id="app"><h1>Busy catalogue</h1><p>${FILLER}</p></div>
<script>setInterval(() => { fetch('/healthz?poll=' + Date.now()).catch(() => {}); }, 200);</script></body></html>`;

let gzipBomb;
function getGzipBomb() {
  gzipBomb ??= gzipSync(Buffer.alloc(64 * MB, 0x41));
  return gzipBomb;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://fixture');
  const path = url.pathname;
  const origin = `http://${req.headers.host ?? `localhost:${port}`}`;

  if (path === '/healthz') return send(res, 200, 'text/plain', 'ok');
  if (path.startsWith('/canary/')) {
    hitCanary(path.slice('/canary/'.length));
    return send(res, 200, 'text/html', '<html><body>canary</body></html>');
  }
  if (path === '/canary-hits')
    return send(res, 200, 'application/json', JSON.stringify(Object.fromEntries(canaryHits)));
  if (path === '/escape-probe') {
    const rawPort = Number(url.searchParams.get('raw') ?? process.env.RAW_CANARY_PORT ?? 8089);
    return send(
      res,
      200,
      'text/html; charset=utf-8',
      escapeProbe(url.searchParams.get('id') ?? 'x', origin, rawPort),
    );
  }
  if (path === '/canary-raw') return send(res, 200, 'application/json', JSON.stringify(rawCanary));
  if (path === '/bytes') {
    const mb = Math.min(Number(url.searchParams.get('mb') ?? '1'), 14);
    return send(res, 200, 'text/javascript', Buffer.alloc(mb * MB, 0x20));
  }
  if (path === '/budget-bytes') return send(res, 200, 'text/html; charset=utf-8', BUDGET_BYTES_PAGE);
  if (path === '/budget-count') return send(res, 200, 'text/html; charset=utf-8', BUDGET_COUNT_PAGE);
  if (path === '/busy-page') return send(res, 200, 'text/html; charset=utf-8', BUSY_PAGE);
  if (path.startsWith('/nonce/')) {
    const nonce = path.slice('/nonce/'.length).replace(/[^a-zA-Z0-9-]/g, '');
    return send(
      res,
      200,
      'text/html; charset=utf-8',
      `<!DOCTYPE html><html lang="en"><body><div class="attribute-long"><h1>Smoke run ${nonce}</h1><p>${FILLER}</p></div></body></html>`,
    );
  }
  if (path === '/big-plain') {
    // 16 MB with an honest Content-Length (rejected from the header).
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(16 * MB) });
    return res.end(Buffer.alloc(16 * MB, 0x41));
  }
  if (path === '/big-chunked') {
    // 16 MB, chunked, no Content-Length (rejected by the streaming cap).
    res.writeHead(200, { 'content-type': 'text/html' });
    const chunk = Buffer.alloc(MB, 0x41);
    let sent = 0;
    const pump = () => {
      while (sent < 16) {
        sent += 1;
        if (!res.write(chunk)) return void res.once('drain', pump);
      }
      res.end();
    };
    res.on('error', () => {});
    return pump();
  }
  if (path === '/gzip-bomb') {
    // ~64 KB on the wire, 64 MB decoded (rejected by the decoded-size cap).
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    return res.end(getGzipBomb());
  }
  if (path === '/drip') {
    // One byte every 500 ms, forever: only an overall deadline stops it.
    res.writeHead(200, { 'content-type': 'text/html' });
    const timer = setInterval(() => res.write('a'), 500);
    res.on('close', () => clearInterval(timer));
    return;
  }
  if (path === '/offsite') {
    res.writeHead(302, { location: 'https://evil.example.com/landing' });
    return res.end();
  }
  if (path === '/moved-hub') {
    res.writeHead(301, { location: '/hub' });
    return res.end();
  }
  if (path === '/waf-blocked') {
    res.writeHead(403, {
      'content-type': 'text/html; charset=UTF-8',
      'cf-mitigated': 'challenge',
      server: 'cloudflare',
    });
    return res.end(WAF_PAGE);
  }

  const route = staticRoutes[path];
  if (!route)
    return send(res, 404, 'text/html; charset=utf-8', '<html><body><h1>404 Not Found</h1></body></html>');
  const [file, type] = route;
  try {
    return send(res, 200, type, await readFile(PUBLIC + file));
  } catch {
    return send(res, 500, 'text/plain', 'fixture read error');
  }
});

// WebSocket handshakes never reach the request handler: count them as canary hits, then drop the socket.
server.on('upgrade', (req, socket) => {
  const path = new URL(req.url ?? '/', 'http://fixture').pathname;
  if (path.startsWith('/canary/')) hitCanary(path.slice('/canary/'.length));
  socket.destroy();
});

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

server.listen(port, '0.0.0.0', () => console.log(`fixture-sites listening on :${port}`));
