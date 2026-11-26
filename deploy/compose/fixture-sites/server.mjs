// Deterministic fixture web server for crawler integration tests. Dependency-free (node:http only).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const port = Number(process.env.PORT ?? 8088);

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://fixture');
  const path = url.pathname;

  if (path === '/healthz') return send(res, 200, 'text/plain', 'ok');
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

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

server.listen(port, '0.0.0.0', () => console.log(`fixture-sites listening on :${port}`));
