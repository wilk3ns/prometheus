/** Normalised URL string used for crawl dedupe: no fragment, no `utm_*` params, default port dropped. */
export function normalizeUrl(input: string | URL): string {
  const url = new URL(typeof input === 'string' ? input : input.href);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_')) url.searchParams.delete(key);
  }
  if (url.search === '?') url.search = '';
  if (url.hostname.endsWith('.')) url.hostname = url.hostname.slice(0, -1);
  return url.href;
}

/** Parses an absolute http(s) URL without credentials; anything else is `undefined`. */
export function parseHttpUrl(value: string, base?: string): URL | undefined {
  let url: URL;
  try {
    url = base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username !== '' || url.password !== '') return undefined;
  return url;
}

export function looksLikePdfUrl(url: URL): boolean {
  return url.pathname.toLowerCase().endsWith('.pdf');
}
