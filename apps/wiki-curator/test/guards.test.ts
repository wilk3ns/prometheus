import { describe, expect, it } from 'vitest';
import { isNonPublicAddress, STRICT_ADDRESS_POLICY } from '../src/crawler/address-policy.js';
import { DomainAllowlist } from '../src/crawler/allowlist.js';
import { RequestGuard } from '../src/crawler/request-guard.js';
import { normalizeUrl, parseHttpUrl } from '../src/crawler/url.js';
import { isChallengeGate } from '../src/crawler/waf-detector.js';
import { fixtureAllowlistEntry } from './support/fixtures.js';

const allowlist = new DomainAllowlist([
  fixtureAllowlistEntry('pw.edu.pl'),
  fixtureAllowlistEntry('irk.pw.edu.pl', { allow_subdomains: false, default_fetch_mode: 'JS_CATALOG' }),
  fixtureAllowlistEntry('anabin.kmk.org', { allow_subdomains: false, default_fetch_mode: 'JS_CATALOG' }),
]);

describe('[T1-G4] allowlist matcher (rule 1)', () => {
  it('matches exact hosts and subdomains only where allow_subdomains = true', () => {
    expect(allowlist.match('pw.edu.pl')?.host).toBe('pw.edu.pl');
    expect(allowlist.match('www.students.pw.edu.pl')?.host).toBe('pw.edu.pl');
    expect(allowlist.match('anabin.kmk.org')?.host).toBe('anabin.kmk.org');
    expect(allowlist.match('www.anabin.kmk.org')).toBeUndefined();
    expect(allowlist.match('kmk.org')).toBeUndefined();
  });

  it('most specific entry wins; a no-subdomain entry never shadows a broader parent', () => {
    expect(allowlist.fetchModeFor(new URL('https://irk.pw.edu.pl/'))).toBe('JS_CATALOG');
    expect(allowlist.match('x.irk.pw.edu.pl')?.host).toBe('pw.edu.pl');
  });

  it('rejects look-alike, suffix-extension, IP-literal and non-http hosts', () => {
    expect(allowlist.match('evilpw.edu.pl')).toBeUndefined();
    expect(allowlist.match('pw.edu.pl.evil.com')).toBeUndefined();
    expect(allowlist.match('PW.EDU.PL.')?.host).toBe('pw.edu.pl');
    expect(allowlist.match('127.0.0.1')).toBeUndefined();
    expect(allowlist.allows(new URL('ftp://pw.edu.pl/x'))).toBe(false);
  });

  it('[LOW-5] only default ports, except explicitly exempted local fixture hosts', () => {
    expect(allowlist.allows(new URL('https://pw.edu.pl:443/x'))).toBe(true);
    expect(allowlist.allows(new URL('http://pw.edu.pl:80/x'))).toBe(true);
    expect(allowlist.allows(new URL('https://pw.edu.pl:8443/x'))).toBe(false);
    expect(allowlist.allows(new URL('http://pw.edu.pl:6379/x'))).toBe(false);
    const local = new DomainAllowlist([fixtureAllowlistEntry('localhost')], {
      nonDefaultPortHosts: new Set(['localhost']),
    });
    expect(local.allows(new URL('http://localhost:8088/hub'))).toBe(true);
    expect(allowlist.allows(new URL('http://www.pw.edu.pl:8088/'))).toBe(false);
  });
});

describe('[T1-G4] SSRF address policy (rule 1)', () => {
  it.each([
    '127.0.0.1',
    '127.8.9.10',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '100.64.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '[::1]',
    'not-an-ip',
    // [MEDIUM IPv6] transition / translation prefixes that can carry an internal IPv4
    '2002:7f00:1::1', // 6to4 -> 127.0.0.1
    '2002:a9fe:a9fe::1', // 6to4 -> 169.254.169.254
    '64:ff9b::7f00:1', // NAT64 WKP -> 127.0.0.1
    '64:ff9b::a9fe:a9fe', // NAT64 WKP -> 169.254.169.254
    '64:ff9b::808:808', // NAT64 WKP, even with a public IPv4: blocked outright
    '64:ff9b:1::1', // local-use NAT64
    '::ffff:0:7f00:1', // IPv4-translated (SIIT)
    '::ffff:0:a9fe:a9fe',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    '::7f00:1', // deprecated IPv4-compatible
    '::127.0.0.1',
    'fec0::1', // site-local
    '100::1', // discard-only
    '2001:db8::1', // documentation
    '192.0.2.10', // TEST-NET-1
  ])('blocks %s', (ip) => {
    expect(isNonPublicAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '172.32.0.1', '193.0.10.1', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8'])(
    'allows public %s',
    (ip) => {
      expect(isNonPublicAddress(ip)).toBe(false);
    },
  );

  it('checks RESOLVED addresses: an allowlisted name pointing at a private IP is blocked', async () => {
    const rebinding = new RequestGuard(allowlist, STRICT_ADDRESS_POLICY, () =>
      Promise.resolve(['93.184.216.34', '10.0.0.5']),
    );
    expect(await rebinding.check(new URL('https://www.pw.edu.pl/'))).toBe('BLOCKED_PRIVATE_ADDRESS');
    const publicOnly = new RequestGuard(allowlist, STRICT_ADDRESS_POLICY, () =>
      Promise.resolve(['93.184.216.34']),
    );
    expect(await publicOnly.check(new URL('https://www.pw.edu.pl/'))).toBe('OK');
    expect(await publicOnly.check(new URL('https://evil.example.com/'))).toBe('DISALLOWED_HOST');
  });

  it('[LOW-1] local fixture exemption is host-scoped: other hosts and IP literals stay strict', async () => {
    const resolveLoopback = () => Promise.resolve(['127.0.0.1']);
    const strict = new RequestGuard(allowlist, STRICT_ADDRESS_POLICY, resolveLoopback);
    const local = new RequestGuard(
      allowlist,
      { nonPublicAllowedHosts: new Set(['pw.edu.pl']) },
      resolveLoopback,
    );
    expect(await strict.check(new URL('http://pw.edu.pl/'))).toBe('BLOCKED_PRIVATE_ADDRESS');
    expect(await local.check(new URL('http://pw.edu.pl/'))).toBe('OK');
    // a live official host crawled in the same process keeps the private-IP block
    expect(await local.check(new URL('http://www.pw.edu.pl/'))).toBe('BLOCKED_PRIVATE_ADDRESS');
    expect(await local.checkAddressOnly(new URL('http://127.0.0.1:8088/'))).toBe('BLOCKED_PRIVATE_ADDRESS');
    expect(await strict.checkAddressOnly(new URL('http://169.254.169.254/latest/meta-data'))).toBe(
      'BLOCKED_PRIVATE_ADDRESS',
    );
  });

  it('connect-time lookup fails closed on a non-public answer (DNS rebinding defence)', async () => {
    const guard = new RequestGuard(allowlist, STRICT_ADDRESS_POLICY);
    const error = await new Promise<unknown>((resolve) => {
      guard.connectLookup('localhost', {}, (err) => resolve(err));
    });
    expect(error).toMatchObject({ code: 'ERR_PROMETHEUS_BLOCKED_ADDRESS' });
  });
});

describe('[T1-G4] URL normalisation (rule 4)', () => {
  it('strips fragments and utm_* params but keeps meaningful query params', () => {
    expect(normalizeUrl('https://pw.edu.pl/a?utm_source=x&id=3&UTM_medium=y#top')).toBe(
      'https://pw.edu.pl/a?id=3',
    );
    expect(normalizeUrl('https://pw.edu.pl:443/a?utm_source=x')).toBe('https://pw.edu.pl/a');
    expect(normalizeUrl('https://pw.edu.pl/Health-Insuarance/')).toBe('https://pw.edu.pl/Health-Insuarance/');
  });

  it('accepts only absolute http(s) URLs without credentials', () => {
    expect(parseHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(parseHttpUrl('https://user:pw@pw.edu.pl/')).toBeUndefined();
    expect(parseHttpUrl('cennik.pdf', 'https://pw.edu.pl/pl/')?.href).toBe('https://pw.edu.pl/pl/cennik.pdf');
  });
});

describe('[T1-G7] WAF / CAPTCHA challenge detection (rule 2)', () => {
  const base = { headers: {}, cleanCharCount: undefined, minContentChars: 500 };

  it('flags cf-mitigated responses regardless of body', () => {
    expect(
      isChallengeGate({ ...base, status: 403, headers: { 'cf-mitigated': 'challenge' }, html: undefined }),
    ).toBe(true);
  });

  it('flags Turnstile / reCAPTCHA / hCaptcha interstitials on blocking statuses or near-empty pages', () => {
    const turnstile = '<div class="cf-turnstile" data-sitekey="x"></div>';
    expect(isChallengeGate({ ...base, status: 403, html: turnstile })).toBe(true);
    expect(
      isChallengeGate({
        ...base,
        status: 503,
        html: '<script src="/cdn-cgi/challenge-platform/h/b"></script>',
      }),
    ).toBe(true);
    expect(
      isChallengeGate({ ...base, status: 200, html: '<div class="h-captcha"></div>', cleanCharCount: 40 }),
    ).toBe(true);
  });

  it('does not flag full official pages that merely embed Cloudflare JS or a reCAPTCHA contact form', () => {
    const page =
      '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script><div class="g-recaptcha"></div>';
    expect(isChallengeGate({ ...base, status: 200, html: page, cleanCharCount: 4000 })).toBe(false);
    expect(isChallengeGate({ ...base, status: 404, html: '<h1>Not found</h1>' })).toBe(false);
  });
});
