import type { DiscoveredLink } from '@prometheus/contracts';
import { type ChildNode, type Element, isTag, isText } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import type { DomainAllowlist } from './allowlist.js';
import { looksLikePdfUrl, normalizeUrl, parseHttpUrl } from './url.js';

/**
 * Legacy-safe HTML -> clean structured text (ENG-T1 §3 rules 3 + 4).
 *
 * - Never assumes `<main>`/`<article>`: strips chrome, then narrows to the content root by DOM text
 *   density, dropping only link-dense chrome (see `selectContentRoot`).
 * - Data tables become pipe-delimited Markdown tables (colspan/rowspan expanded) so tuition / tariff /
 *   score matrices survive intact for T2 `verbatim_quote` matching.
 * - Links are harvested from the whole document (nav/footer included), resolved against `<base href>` /
 *   the final URL, normalised, deduplicated and filtered to the official allowlist. Never synthesised.
 */

export interface HtmlExtraction {
  readonly cleanText: string;
  readonly cleanCharCount: number;
  readonly links: readonly DiscoveredLink[];
  readonly lang: string | null;
}

const STRIP_TAGS: ReadonlySet<string> = new Set([
  'script',
  'style',
  'noscript',
  'svg',
  'nav',
  'footer',
  'template',
  'iframe',
  'object',
  'embed',
  'canvas',
  'select',
  'head',
]);

const COOKIE_CHROME =
  /(^|[\s_-])(cookie|cookies|consent|gdpr|onetrust|cookiebot|cc-banner|cc-window)([\s_-]|$)/i;

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'dd',
  'details',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'form',
  'header',
  'hgroup',
  'html',
  'legend',
  'main',
  'section',
  'summary',
  'p',
  'caption',
]);

const HEADING = /^h([1-6])$/;
const CONTAINER_TAGS: ReadonlySet<string> = new Set(['div', 'section', 'article', 'main', 'form', 'center']);
const DROPPABLE_MIN_CHARS = 40;
const DROPPABLE_SHARE = 0.03;
const MAX_SPAN = 50;
const LAYOUT_CELL_CHARS = 1000;
const MAX_ANCHOR_CHARS = 300;

function attr(el: Element, name: string): string | undefined {
  return el.attribs[name];
}

function isStripped(el: Element): boolean {
  const tag = el.name.toLowerCase();
  if (tag === 'html' || tag === 'body' || tag === 'main') return false;
  if (STRIP_TAGS.has(tag)) return true;
  if (attr(el, 'aria-hidden') === 'true' || attr(el, 'hidden') !== undefined) return true;
  const role = attr(el, 'role');
  if (role === 'navigation' || role === 'contentinfo') return true;
  const idClass = `${attr(el, 'id') ?? ''} ${attr(el, 'class') ?? ''}`;
  return COOKIE_CHROME.test(idClass);
}

function visibleChildren(node: Element): ChildNode[] {
  return node.children.filter((c) => !(isTag(c) && isStripped(c)));
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ');
}

function rawText(node: ChildNode): string {
  if (isText(node)) return node.data;
  if (isTag(node)) return node.children.map(rawText).join('');
  return '';
}

interface Density {
  readonly nonLinkChars: number;
  readonly dataTables: number;
}

/** Measures visible non-link text and data-table count under every element (memoised per element). */
class DensityMap {
  private readonly cache = new Map<Element, Density>();

  of(el: Element): Density {
    const hit = this.cache.get(el);
    if (hit) return hit;
    let nonLinkChars = 0;
    let dataTables = 0;
    const tag = el.name.toLowerCase();
    if (tag === 'table' && !isLayoutTable(el)) dataTables += 1;
    for (const child of visibleChildren(el)) {
      if (isText(child)) {
        nonLinkChars += collapse(child.data).trim().length;
      } else if (isTag(child)) {
        const d = this.of(child);
        dataTables += d.dataTables;
        if (child.name.toLowerCase() !== 'a') nonLinkChars += d.nonLinkChars;
      }
    }
    const result = { nonLinkChars, dataTables };
    this.cache.set(el, result);
    return result;
  }
}

/**
 * Conservative DOM-density root selection: descend from <body> into a container child only when everything
 * left behind (its visible siblings + loose text) carries almost no non-link text, i.e. is link chrome
 * (menus, breadcrumbs, social links), and the child keeps every data table. Headings, intro paragraphs and
 * link lists inside content are therefore never cut; when in doubt the wider subtree wins.
 */
function selectContentRoot(body: Element): Element {
  const density = new DensityMap();
  const total = density.of(body);
  const allowance = Math.max(DROPPABLE_MIN_CHARS, DROPPABLE_SHARE * total.nonLinkChars);
  let current = body;
  for (;;) {
    const here = density.of(current);
    const next = visibleChildren(current).find(
      (c): c is Element =>
        isTag(c) &&
        CONTAINER_TAGS.has(c.name.toLowerCase()) &&
        density.of(c).dataTables === total.dataTables &&
        here.nonLinkChars - density.of(c).nonLinkChars <= allowance,
    );
    if (!next) return current;
    current = next;
  }
}

function findFirst(nodes: readonly ChildNode[], predicate: (el: Element) => boolean): Element | undefined {
  for (const node of nodes) {
    if (!isTag(node)) continue;
    if (predicate(node)) return node;
    const deep = findFirst(node.children, predicate);
    if (deep) return deep;
  }
  return undefined;
}

function findAll(
  nodes: readonly ChildNode[],
  predicate: (el: Element) => boolean,
  out: Element[] = [],
): Element[] {
  for (const node of nodes) {
    if (!isTag(node)) continue;
    if (predicate(node)) out.push(node);
    findAll(node.children, predicate, out);
  }
  return out;
}

// ---------------------------------------------------------------- tables

function isLayoutTable(table: Element): boolean {
  const role = attr(table, 'role');
  if (role === 'presentation' || role === 'none') return true;
  if (findFirst(table.children, (el) => el.name.toLowerCase() === 'table')) return true;
  return findAll(table.children, (el) => /^t[dh]$/i.test(el.name)).some(
    (cell) => collapse(rawText(cell)).trim().length > LAYOUT_CELL_CHARS,
  );
}

/** Rows that belong to `table` itself (not to a nested table). */
function ownRows(table: Element): Element[] {
  const rows: Element[] = [];
  const walk = (nodes: readonly ChildNode[]): void => {
    for (const n of nodes) {
      if (!isTag(n)) continue;
      const tag = n.name.toLowerCase();
      if (tag === 'table') continue;
      if (tag === 'tr') rows.push(n);
      else walk(n.children);
    }
  };
  walk(table.children);
  return rows;
}

function span(el: Element, name: string): number {
  const n = Number.parseInt(attr(el, name) ?? '1', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_SPAN) : 1;
}

function cellText(cell: Element, renderer: Renderer): string {
  return collapse(renderer.inline(cell)).trim().replace(/\|/g, '\\|');
}

function renderTable(table: Element, renderer: Renderer): string {
  const grid: string[][] = [];
  const carry: Array<{ text: string; left: number } | undefined> = [];
  let headerIsTh = false;

  ownRows(table).forEach((tr, r) => {
    const row: string[] = [];
    let col = 0;
    const takeCarried = (): void => {
      for (let c = carry[col]; c !== undefined && c.left > 0; c = carry[col]) {
        row[col] = c.text;
        c.left -= 1;
        col += 1;
      }
    };
    const cells = tr.children.filter((c): c is Element => isTag(c) && /^t[dh]$/i.test(c.name));
    if (r === 0) headerIsTh = cells.length > 0 && cells.every((c) => c.name.toLowerCase() === 'th');
    for (const cell of cells) {
      takeCarried();
      const text = cellText(cell, renderer);
      const cs = span(cell, 'colspan');
      const rs = span(cell, 'rowspan');
      for (let k = 0; k < cs; k += 1) {
        row[col + k] = k === 0 ? text : '';
        carry[col + k] = rs > 1 ? { text: k === 0 ? text : '', left: rs - 1 } : undefined;
      }
      col += cs;
    }
    takeCarried();
    for (let c = col; c < carry.length; c += 1) {
      const pending = carry[c];
      if (pending !== undefined && pending.left > 0) {
        row[c] = pending.text;
        pending.left -= 1;
      }
    }
    if (row.length > 0) grid.push(Array.from(row, (v) => v ?? ''));
  });

  if (grid.length === 0) return '';
  const width = Math.max(...grid.map((row) => row.length));
  const line = (cells: readonly string[]): string =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ')} |`;
  const header =
    headerIsTh || grid.length === 1 ? (grid[0] as string[]) : Array.from({ length: width }, () => '');
  const body = headerIsTh || grid.length === 1 ? grid.slice(1) : grid;
  return [line(header), line(Array.from({ length: width }, () => '---')), ...body.map(line)].join('\n');
}

// ---------------------------------------------------------------- text rendering

const PARA = '\u0000P\u0000';
const LINE = '\u0000L\u0000';

class Renderer {
  /** Renders a subtree to text with paragraph/line markers; markers are resolved in `finish`. */
  block(node: ChildNode): string {
    if (isText(node)) return collapse(node.data);
    if (!isTag(node) || isStripped(node)) return '';
    const tag = node.name.toLowerCase();
    const inner = (): string =>
      visibleChildren(node)
        .map((c) => this.block(c))
        .join('');
    if (tag === 'br') return LINE;
    if (tag === 'hr') return PARA;
    const heading = HEADING.exec(tag);
    if (heading) return `${PARA}${'#'.repeat(Number(heading[1]))} ${collapse(inner()).trim()}${PARA}`;
    if (tag === 'table') {
      return isLayoutTable(node) ? `${PARA}${inner()}${PARA}` : `${PARA}${renderTable(node, this)}${PARA}`;
    }
    if (tag === 'td' || tag === 'th') return `${PARA}${inner()}${PARA}`; // only reached inside layout tables
    if (tag === 'ul' || tag === 'ol') {
      let n = 0;
      const items = visibleChildren(node).map((c) => {
        if (!isTag(c) || c.name.toLowerCase() !== 'li') return this.block(c);
        n += 1;
        const marker = tag === 'ol' ? `${n}. ` : '- ';
        const content = visibleChildren(c)
          .map((x) => this.block(x))
          .join('')
          .replaceAll(PARA, LINE)
          .split(LINE)
          .map((l) => l.trim())
          .filter((l) => l !== '')
          .join(LINE);
        return `${LINE}${marker}${content}${LINE}`;
      });
      return `${PARA}${items.join('')}${PARA}`;
    }
    if (tag === 'li') return `${LINE}- ${inner().trim()}${LINE}`;
    if (tag === 'pre') return `${PARA}${rawText(node)}${PARA}`;
    if (BLOCK_TAGS.has(tag) || tag === 'tr' || tag === 'tbody' || tag === 'thead' || tag === 'tfoot') {
      return `${PARA}${inner()}${PARA}`;
    }
    return inner();
  }

  /** Single-line rendering for table cells. */
  inline(node: Element): string {
    return this.block(node).replaceAll(PARA, ' ').replaceAll(LINE, ' ');
  }

  finish(marked: string): string {
    return marked
      .split(PARA)
      .map((para) =>
        para
          .split(LINE)
          .map((l) => (l.startsWith('|') ? l.trim() : collapse(l).trim()))
          .filter((l) => l !== '')
          .join('\n'),
      )
      .filter((p) => p !== '')
      .join('\n\n');
  }
}

/** Splits rendered table blocks back into lines (tables are emitted with real newlines). */
function protectTableNewlines(marked: string): string {
  return marked.replace(/\n/g, LINE);
}

// ---------------------------------------------------------------- links + lang

function anchorText(a: Element): string {
  const text = collapse(rawText(a)).trim();
  const fallback =
    attr(a, 'title') ??
    attr(a, 'aria-label') ??
    findFirst(a.children, (el) => el.name === 'img')?.attribs['alt'] ??
    '';
  return (text || collapse(fallback).trim()).slice(0, MAX_ANCHOR_CHARS);
}

function harvestLinks(
  roots: readonly ChildNode[],
  baseUrl: string,
  allowlist: DomainAllowlist,
  self: string,
): DiscoveredLink[] {
  const seen = new Map<string, DiscoveredLink>();
  for (const a of findAll(roots, (el) => el.name.toLowerCase() === 'a' && attr(el, 'href') !== undefined)) {
    const href = (attr(a, 'href') ?? '').trim();
    if (href === '' || href.startsWith('#')) continue;
    const url = parseHttpUrl(href, baseUrl);
    if (!url || !allowlist.allows(url)) continue;
    const normalized = normalizeUrl(url);
    if (normalized === self) continue;
    const existing = seen.get(normalized);
    const text = anchorText(a);
    if (!existing) seen.set(normalized, { anchor_text: text, url: normalized, is_pdf: looksLikePdfUrl(url) });
    else if (existing.anchor_text === '' && text !== '')
      seen.set(normalized, { ...existing, anchor_text: text });
  }
  return [...seen.values()];
}

const LANG_TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

function normalizeLang(value: string | undefined): string | null {
  const tag = (value ?? '').split(',')[0]?.trim().replace(/_/g, '-') ?? '';
  if (!LANG_TAG.test(tag)) return null;
  const lower = tag.toLowerCase();
  if (lower.length <= 8) return lower;
  return lower.split('-')[0] ?? null;
}

export function extractHtml(
  html: string,
  finalUrl: string,
  allowlist: DomainAllowlist,
  contentLanguage?: string,
): HtmlExtraction {
  const doc = parseDocument(html, {
    decodeEntities: true,
    lowerCaseTags: true,
    lowerCaseAttributeNames: true,
  });
  const htmlEl = findFirst(doc.children, (el) => el.name === 'html');
  const body = findFirst(doc.children, (el) => el.name === 'body');

  const baseHref = findFirst(doc.children, (el) => el.name === 'base' && attr(el, 'href') !== undefined)
    ?.attribs['href'];
  const base = (baseHref !== undefined ? parseHttpUrl(baseHref, finalUrl)?.href : undefined) ?? finalUrl;
  const links = harvestLinks(doc.children, base, allowlist, normalizeUrl(finalUrl));

  const renderer = new Renderer();
  // Fragments without <body> render every top-level node.
  const marked = body
    ? renderer.block(selectContentRoot(body))
    : doc.children.map((c) => renderer.block(c)).join('');
  const cleanText = renderer.finish(protectTableNewlines(marked));

  return {
    cleanText,
    cleanCharCount: [...cleanText].length,
    links,
    lang:
      normalizeLang(htmlEl?.attribs['lang'] ?? htmlEl?.attribs['xml:lang']) ?? normalizeLang(contentLanguage),
  };
}
