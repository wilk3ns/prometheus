import { describe, expect, it } from 'vitest';
import { ProgramSpecNodeFields, type DiscoveredLink, type ProposalCitation } from '@prometheus/contracts';
import {
  applyLocks,
  normalizeForQuote,
  validateProposal,
  type ValidationInput,
} from '../src/curator/validators.js';
import { decidePublish } from '../src/curator/publish-gate.js';
import { planSources, acceptHealerChoice, type StoredSnapshot } from '../src/curator/healer.js';
import {
  compileCityCard,
  compileDocsCard,
  flattenFacts,
  estimateCardTokens,
} from '../src/curator/slice-cards.js';
import { LAYERS } from '../src/curator/layers.js';
import { pricingTierFor } from '../src/curator/golden-mapping.js';
import { goodFields } from './support/curator-scenarios.js';

const SID = '0193f2a0-0000-7000-8000-0000000000aa';
const URL_A = 'https://www.pw.edu.pl/fees';
const TEXT = 'Tui­tion fee for non‑EU students: EUR 6 000 per year. The “official” deadline – 15 July.';

const cite = (overrides: Partial<ProposalCitation> = {}): ProposalCitation => ({
  field_path: 'tuition_annual_eur',
  snapshot_id: SID,
  source_url: URL_A,
  verbatim_quote: 'Tuition fee for non-EU students: EUR 6 000 per year.',
  retrieved_at: '2026-11-20T10:00:00Z',
  ...overrides,
});

const input = (overrides: Partial<ValidationInput> = {}): ValidationInput => ({
  expectedNodeKey: 'x:2027-FALL',
  nodeKeyOf: () => 'x:2027-FALL',
  proposal: {
    node_key: 'x:2027-FALL',
    fields: { tuition_annual_eur: 6000, app_window_close_at: '2027-07-15T21:59:00Z' },
    citations: [cite()],
  },
  snapshots: new Map([[SID, { id: SID, requestedUrl: URL_A, finalUrl: URL_A, cleanText: TEXT }]]),
  isAllowlisted: (u) => u.hostname.endsWith('pw.edu.pl'),
  lockedPaths: [],
  existingFields: undefined,
  now: new Date('2026-11-27T00:00:00Z'),
  ...overrides,
});

const codes = (i: ValidationInput) => validateProposal(i).errors.map((e) => e.code);

describe('[T2-G5] deterministic post-validator (EG-004 / GR-AI-007 / GR-OPS-014)', () => {
  it('normalises whitespace, NBSP, soft hyphens, typographic quotes and dashes on both sides', () => {
    expect(normalizeForQuote(TEXT)).toBe(
      'Tuition fee for non-EU students: EUR 6 000 per year. The "official" deadline - 15 July.',
    );
    expect(codes(input())).toEqual([]);
    expect(
      codes(
        input({
          proposal: {
            ...input().proposal,
            citations: [cite({ verbatim_quote: 'The "official" deadline - 15 July.' })],
          },
        }),
      ),
    ).toEqual([]);
  });

  it('a quote absent from the snapshot text fails (hallucinated quote)', () => {
    expect(
      codes(
        input({
          proposal: {
            ...input().proposal,
            citations: [cite({ verbatim_quote: 'Tuition fee for non-EU students: EUR 3 000 per year.' })],
          },
        }),
      ),
    ).toEqual(['QUOTE_NOT_FOUND']);
  });

  it('a paraphrase or case change never matches', () => {
    expect(
      codes(
        input({
          proposal: {
            ...input().proposal,
            citations: [cite({ verbatim_quote: 'tuition fee for non-EU students: EUR 6 000 per year.' })],
          },
        }),
      ),
    ).toEqual(['QUOTE_NOT_FOUND']);
  });

  it('quotes shorter than 12 normalised characters fail', () => {
    expect(
      codes(input({ proposal: { ...input().proposal, citations: [cite({ verbatim_quote: 'EUR 6 000' })] } })),
    ).toEqual(['QUOTE_TOO_SHORT']);
  });

  it('a non-allowlisted source host fails even if the quote exists', () => {
    expect(codes(input({ isAllowlisted: () => false }))).toContain('CITATION_NOT_ALLOWLISTED');
  });

  it('citing a URL other than the referenced snapshot fails', () => {
    expect(
      codes(
        input({
          proposal: { ...input().proposal, citations: [cite({ source_url: 'https://www.pw.edu.pl/other' })] },
        }),
      ),
    ).toEqual(['CITATION_URL_MISMATCH']);
  });

  it('an unknown snapshot, an error snapshot without text, or an unknown field path fail', () => {
    expect(codes(input({ snapshots: new Map() }))).toEqual(['CITATION_UNKNOWN_SNAPSHOT']);
    expect(
      codes(
        input({
          snapshots: new Map([[SID, { id: SID, requestedUrl: URL_A, finalUrl: URL_A, cleanText: null }]]),
        }),
      ),
    ).toEqual(['CITATION_SNAPSHOT_WITHOUT_TEXT']);
    expect(
      codes(input({ proposal: { ...input().proposal, citations: [cite({ field_path: 'nope' })] } })),
    ).toEqual(['CITATION_UNKNOWN_FIELD']);
  });

  it('no citations, node-key mismatch, future retrieval and inverted windows fail', () => {
    expect(codes(input({ proposal: { ...input().proposal, citations: [] } }))).toEqual(['NO_CITATIONS']);
    expect(codes(input({ nodeKeyOf: () => 'other:2027-FALL' }))).toEqual(['NODE_KEY_MISMATCH']);
    expect(
      codes(
        input({
          proposal: { ...input().proposal, citations: [cite({ retrieved_at: '2027-01-01T00:00:00Z' })] },
        }),
      ),
    ).toEqual(['RETRIEVED_IN_FUTURE']);
    expect(
      codes(
        input({
          proposal: {
            ...input().proposal,
            fields: {
              tuition_annual_eur: 6000,
              app_window_open_at: '2027-08-01T00:00:00Z',
              app_window_close_at: '2027-07-15T00:00:00Z',
            },
          },
        }),
      ),
    ).toEqual(['DATE_WINDOW_INVERTED']);
  });

  it('LOCKED_BY_HUMAN: pinned paths keep the stored value and report a conflict (nested paths too)', () => {
    const r = validateProposal(
      input({
        lockedPaths: ['tuition_annual_eur', 'program.name_en', 'missing.path'],
        existingFields: { tuition_annual_eur: 4000, program: { name_en: 'Pinned' } },
        proposal: {
          ...input().proposal,
          fields: {
            tuition_annual_eur: 9999,
            program: { name_en: 'Model' },
            app_window_close_at: '2027-07-15T21:59:00Z',
          },
        },
      }),
    );
    expect(r.effectiveFields).toMatchObject({ tuition_annual_eur: 4000, program: { name_en: 'Pinned' } });
    expect(r.lockConflicts).toEqual([
      { path: 'tuition_annual_eur', pinned: 4000, proposed: 9999 },
      { path: 'program.name_en', pinned: 'Pinned', proposed: 'Model' },
    ]);
  });

  it('applyLocks reports no conflict when the proposal agrees with the pin', () => {
    expect(applyLocks({ a: 1 }, ['a'], { a: 1 }).conflicts).toEqual([]);
  });
});

describe('[T2-G5] publish gate (GR-AI-010)', () => {
  const required = LAYERS.PROGRAM_SPEC.requiredPaths;
  const report = { verification_score: 0.95, checked_paths: [...required], discrepancies: [] };

  it('passes only with 0 errors, 0 discrepancies, score >= 0.950, full coverage, no required abstentions', () => {
    expect(
      decidePublish({ validatorErrors: [], report, requiredPaths: required, abstainFields: [] }).pass,
    ).toBe(true);
    expect(
      decidePublish({
        validatorErrors: [],
        report: { ...report, verification_score: 0.949 },
        requiredPaths: required,
        abstainFields: [],
      }).failures,
    ).toEqual(['SCORE_BELOW_THRESHOLD']);
    expect(
      decidePublish({
        validatorErrors: [],
        report: { ...report, checked_paths: required.slice(1) },
        requiredPaths: required,
        abstainFields: [],
      }).failures,
    ).toEqual(['REQUIRED_PATHS_UNCHECKED']);
    expect(
      decidePublish({
        validatorErrors: [],
        report,
        requiredPaths: required,
        abstainFields: ['tuition_annual_eur'],
      }).failures,
    ).toEqual(['REQUIRED_PATHS_ABSTAINED']);
    expect(
      decidePublish({ validatorErrors: [], report: undefined, requiredPaths: required, abstainFields: [] })
        .failures,
    ).toEqual(['NO_VERIFICATION_REPORT']);
    expect(
      decidePublish({
        validatorErrors: [{ code: 'QUOTE_NOT_FOUND', path: 'c', detail: '' }],
        report,
        requiredPaths: required,
        abstainFields: [],
      }).failures,
    ).toEqual(['POST_VALIDATOR_ERRORS']);
    expect(
      decidePublish({
        validatorErrors: [],
        report: { ...report, discrepancies: [{ field_path: 'x', kind: 'OTHER', detail: 'd' }] },
        requiredPaths: required,
        abstainFields: [],
      }).pass,
    ).toBe(false);
  });

  it('a NaN score never passes', () => {
    expect(
      decidePublish({
        validatorErrors: [],
        report: { ...report, verification_score: Number.NaN },
        requiredPaths: required,
        abstainFields: [],
      }).pass,
    ).toBe(false);
  });
});

describe('[T2-G5][T2-G8] snapshot gathering + 404 Healer (ENG-T2 §4 step 1, §0 Q2/Q3)', () => {
  const link = (url: string, anchor: string): DiscoveredLink => ({ url, anchor_text: anchor, is_pdf: false });
  const snap = (id: string, url: string, overrides: Partial<StoredSnapshot> = {}): StoredSnapshot => ({
    id,
    requestedUrl: url,
    finalUrl: url,
    contentKind: 'HTML',
    errorCode: null,
    cleanTextBlobRef: `wiki-snapshots/text/${id}.txt`,
    discoveredLinks: [],
    fetchedAt: '2026-11-20T10:00:00.000Z',
    ...overrides,
  });
  const err = (id: string, url: string, code: StoredSnapshot['errorCode']) =>
    snap(id, url, { contentKind: 'HTTP_ERROR', errorCode: code, cleanTextBlobRef: null });

  const HUB = 'https://www.pw.edu.pl/hub';
  const MISSING = 'https://www.pw.edu.pl/fees/tuition-2027.pdf';
  const SIBLING = 'https://www.pw.edu.pl/fees/tuition-2027-v2.pdf';

  it('heals a 404 with the best-scoring allowlisted sibling that already has a content snapshot', () => {
    const rows = [
      snap('hub', HUB, {
        discoveredLinks: [
          link(MISSING, 'Tuition 2027'),
          link(SIBLING, 'Tuition 2027 (updated)'),
          link('https://www.pw.edu.pl/news', 'News'),
        ],
      }),
      err('miss', MISSING, 'MISSING_SOURCE_404'),
      snap('sib', SIBLING),
      snap('news', 'https://www.pw.edu.pl/news'),
    ];
    const plan = planSources([MISSING], rows);
    expect(plan.healed).toEqual([{ missingUrl: MISSING, replacementUrl: SIBLING }]);
    expect(plan.snapshots[0]?.id).toBe('sib');
    expect(plan.slots).toEqual({});
  });

  it('an unrecoverable 404 becomes slot MISSING_SOURCE_404', () => {
    const plan = planSources([MISSING], [err('miss', MISSING, 'MISSING_SOURCE_404')]);
    expect(plan.slots).toEqual({ [`source:${MISSING}`]: { status: 'MISSING_SOURCE_404' } });
  });

  it('FETCH_TIMEOUT / NETWORK_ERROR (http_status 0) are transient, ROBOTS_DISALLOWED needs a human or PDF fetch', () => {
    const a = 'https://www.pw.edu.pl/a';
    const b = 'https://www.pw.edu.pl/b';
    const c = 'https://www.pw.edu.pl/c';
    const plan = planSources(
      [a, b, c],
      [err('a', a, 'FETCH_TIMEOUT'), err('b', b, 'NETWORK_ERROR'), err('c', c, 'ROBOTS_DISALLOWED')],
    );
    expect(plan.slots).toEqual({
      [`source:${a}`]: { status: 'TRANSIENT_FETCH_FAILURE', note: 'FETCH_TIMEOUT' },
      [`source:${b}`]: { status: 'TRANSIENT_FETCH_FAILURE', note: 'NETWORK_ERROR' },
      [`source:${c}`]: { status: 'NEEDS_HUMAN_OR_PDF_FETCH', note: 'ROBOTS_DISALLOWED' },
    });
  });

  it('the latest snapshot of a URL wins (a later 200 supersedes an earlier 404)', () => {
    const plan = planSources(
      [MISSING],
      [
        err('old', MISSING, 'MISSING_SOURCE_404'),
        snap('new', MISSING, { fetchedAt: '2026-11-21T00:00:00.000Z' }),
      ],
    );
    expect(plan.snapshots.map((s) => s.id)).toEqual(['new']);
  });

  it('a model tie-break is accepted only for one of the offered candidates', () => {
    const other = 'https://www.pw.edu.pl/fees/tuition-2027-alt.pdf';
    const rows = [
      snap('hub', HUB, {
        discoveredLinks: [
          link(MISSING, 'Tuition 2027'),
          link(SIBLING, 'Tuition 2027'),
          link(other, 'Tuition 2027'),
        ],
      }),
      err('miss', MISSING, 'MISSING_SOURCE_404'),
      snap('sib', SIBLING),
      snap('alt', other),
    ];
    const plan = planSources([MISSING], rows);
    expect(plan.ambiguous).toHaveLength(1);
    expect(acceptHealerChoice(plan, MISSING, 'https://evil.example.com/x', rows)).toBe(plan);
    expect(acceptHealerChoice(plan, MISSING, other, rows).healed).toEqual([
      { missingUrl: MISSING, replacementUrl: other },
    ]);
  });
});

describe('[T2-G6] deterministic Slice Card compiler (<350 tokens, 0 LLM tokens)', () => {
  const meta = { depth: 'DEEP_VERIFIED' as const, version: 3, citations: [] };
  const huge = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`rule_${i}`, 'x'.repeat(50)]));

  it('caps every card at 350 estimated tokens (1,400 chars) even with a huge payload, and keeps the Sources line', () => {
    const card = compileDocsCard({
      ...meta,
      spec: ProgramSpecNodeFields.parse({ ...goodFields(), program_requirements_json: huge }),
      university: {
        id: 't2verify',
        name_en: 'T2 Verify University of Technology',
        official_domain: 'pw.edu.pl',
      },
    });
    expect(card.text.length).toBeLessThanOrEqual(1_400);
    expect(card.est_tokens).toBe(estimateCardTokens(card.text));
    expect(card.est_tokens).toBeLessThanOrEqual(350);
    expect(card.text.split('\n').at(-1)).toBe('Sources: pw.edu.pl');
    expect(card.source_domains).toEqual(['pw.edu.pl']);
  });

  it('is deterministic: same input, byte-identical card; key order of payloads does not matter', () => {
    const city = {
      id: 'PL-X',
      country_iso2: 'PL' as const,
      city_name_en: 'X',
      monthly_living_min_eur: null,
      monthly_living_max_eur: null,
      minor_consents_json: [],
      attributes_json: { b: 1, a: { d: 2, c: 3 } },
    };
    const reordered = { ...city, attributes_json: { a: { c: 3, d: 2 }, b: 1 } };
    expect(compileCityCard({ ...meta, city, season: '2027-FALL' })).toEqual(
      compileCityCard({ ...meta, city: reordered, season: '2027-FALL' }),
    );
  });

  it('flattens payloads canonically', () => {
    expect(flattenFacts({ b: [1, 2], a: { y: null, x: 'v' } })).toEqual(['a.x: v', 'b: 1, 2']);
  });
});

describe('[T2-G6] B5 pricing tier by destination country (PRD docs/01 L207, Option C)', () => {
  it('maps all 5 destination countries: TR->T1, PL/HU->T2, IT/DE->T3', () => {
    expect(['TR', 'PL', 'HU', 'IT', 'DE'].map((c) => [c, pricingTierFor(c)])).toEqual([
      ['TR', 'T1'],
      ['PL', 'T2'],
      ['HU', 'T2'],
      ['IT', 'T3'],
      ['DE', 'T3'],
    ]);
  });

  it('fails loudly for a country outside the five destinations (no default tier)', () => {
    expect(() => pricingTierFor('FR')).toThrow(RangeError);
  });
});
