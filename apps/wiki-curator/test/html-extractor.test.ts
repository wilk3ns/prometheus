import { describe, expect, it } from 'vitest';
import { DomainAllowlist } from '../src/crawler/allowlist.js';
import { extractHtml } from '../src/crawler/html-extractor.js';
import { fixtureAllowlistEntry, fixtureFile } from './support/fixtures.js';

const allowlist = new DomainAllowlist([fixtureAllowlistEntry('fixture.pw.edu.pl')]);
const HUB = 'http://fixture.pw.edu.pl/hub';

describe('[T1-G4] html-extractor (legacy-safe, table-preserving, multilingual links)', () => {
  const hub = extractHtml(fixtureFile('hub.html').toString('utf8'), HUB, allowlist);

  it('extracts content from a page without <main>/<article> (div.attribute-long)', () => {
    expect(hub.cleanText).toContain('# Admission to B.Sc. studies for foreign candidates');
    expect(hub.cleanText).toContain('must be legalised or carry an apostille.');
    expect(hub.cleanCharCount).toBeGreaterThanOrEqual(500);
    expect(hub.lang).toBe('en');
  });

  it('strips script/style/nav/footer/noscript, cookie banners and aria-hidden chrome', () => {
    for (const chrome of [
      'dataLayer',
      'border: 1px',
      'Our YouTube channel',
      'Copyright',
      'enable JavaScript',
      'We use cookies',
      'Increase font size',
    ]) {
      expect(hub.cleanText).not.toContain(chrome);
    }
  });

  it('preserves the tuition table as a pipe-delimited Markdown table (escaped inner pipes)', () => {
    expect(hub.cleanText).toContain(
      [
        '| Programme | Level | Fee per year |',
        '| --- | --- | --- |',
        '| Computer Science | B.Sc. | EUR 3,000 |',
        '| Computer Systems and Networks | B.Sc. | EUR 3,000 |',
        '| Application fee \\| non-refundable | all | PLN 85 |',
      ].join('\n'),
    );
  });

  it('harvests allowlisted, normalised, deduplicated hrefs incl. local-language paths and PDFs', () => {
    const urls = hub.links.map((l) => l.url);
    expect(urls).toEqual(
      expect.arrayContaining([
        'http://fixture.pw.edu.pl/pl/cennik-ds',
        'http://fixture.pw.edu.pl/sample.pdf',
        'http://fixture.pw.edu.pl/broken-404',
        'http://fixture.pw.edu.pl/offsite',
      ]),
    );
    expect(urls.filter((u) => u.includes('cennik-ds'))).toHaveLength(1); // utm_* + #fragment variant deduped
    expect(urls.some((u) => u.includes('youtube'))).toBe(false); // off-allowlist dropped
    expect(urls.some((u) => u.startsWith('mailto'))).toBe(false);
    expect(urls).not.toContain(HUB); // self links (#fees) dropped
    expect(hub.links.find((l) => l.url.endsWith('/sample.pdf'))).toEqual({
      anchor_text: "Rector's Decree on dormitory tariffs (PDF)",
      url: 'http://fixture.pw.edu.pl/sample.pdf',
      is_pdf: true,
    });
  });

  it('reports a JS shell as near-empty so Tier 2 escalation can trigger', () => {
    const shell = extractHtml(
      fixtureFile('js-catalog.html').toString('utf8'),
      'http://fixture.pw.edu.pl/js-catalog',
      allowlist,
    );
    expect(shell.cleanText).toBe('Loading...');
    expect(shell.cleanCharCount).toBeLessThan(100);
  });

  it('expands colspan/rowspan and keeps layout tables as plain blocks', () => {
    const html = `<html><body><table>
      <tr><th>Item</th><th colspan="2">Fee</th></tr>
      <tr><td rowspan="2">Dorm</td><td>single</td><td>1050</td></tr>
      <tr><td>double</td><td>720</td></tr></table>
      <table role="presentation"><tr><td><p>Layout cell text</p></td></tr></table></body></html>`;
    const out = extractHtml(html, 'http://fixture.pw.edu.pl/x', allowlist).cleanText;
    expect(out).toContain(
      '| Item | Fee |  |\n| --- | --- | --- |\n| Dorm | single | 1050 |\n| Dorm | double | 720 |',
    );
    expect(out).toContain('Layout cell text');
    expect(out).not.toContain('| Layout');
  });

  it('honours <base href> and lists', () => {
    const html = `<html lang="pl-PL"><head><base href="http://fixture.pw.edu.pl/pl/"></head><body>
      <ul><li>Rekrutacja</li><li><a href="cennik.pdf">Cennik</a></li></ul></body></html>`;
    const out = extractHtml(html, 'http://fixture.pw.edu.pl/x', allowlist);
    expect(out.links.map((l) => l.url)).toEqual(['http://fixture.pw.edu.pl/pl/cennik.pdf']);
    expect(out.cleanText).toBe('- Rekrutacja\n- Cennik');
    expect(out.lang).toBe('pl-pl');
  });
});
