import { fileURLToPath } from 'node:url';
import type { ProgramSpecNodeFields, VerificationReport, WikiNodeProposal } from '@prometheus/contracts';
import { cassetteKey, cassetteMaterialFor, type Cassette } from '@prometheus/ai';
import { LAYERS } from '../../src/curator/layers.js';
import {
  buildExtractCall,
  buildVerifyCall,
  gateDecision,
  retryFeedback,
  validateNodeProposal,
  type ExistingView,
  type Gathered,
  type NodeTarget,
  type Validated,
} from '../../src/curator/pipeline.js';

/**
 * Synthetic, fully deterministic WF-03 scenarios for curator-verify.it.ts ([T2-G5]). Each scenario fixes the
 * official snapshot (id, URL, text, fetch time), the scripted Agent A / Agent B outputs per round, and any
 * pre-existing node. `synthesizeCassettes()` builds the replay cassettes with the SAME pure call builders and
 * validators the workflow uses, so the committed cassettes (repo `cassettes/`) key exactly to the live calls.
 */

export const SEASON = '2027-FALL';
export const UNIVERSITY_ID = 't2verify';
export const CITY_ID = 'PL-T2VERIFY';
export const HOST = 'www.pw.edu.pl';
export const CASSETTE_DIR = fileURLToPath(new URL('../../../../cassettes/', import.meta.url));

export const isAllowlistedForScenarios = (url: URL): boolean =>
  url.hostname === 'pw.edu.pl' || url.hostname.endsWith('.pw.edu.pl');

const RETRIEVED = '2026-11-20T10:00:00.000Z';
const NOW = new Date('2026-11-27T12:00:00Z');

const PAGE = (tuition: string) =>
  [
    'T2 Verify University of Technology - Computer Science (B.Sc.), taught in English.',
    `Tuition fee for non-EU students: EUR ${tuition} per year.`,
    'Application deadline for non-EU candidates: 15 July 2027 (23:59 CEST).',
    'EU candidates may apply until 31 August 2027.',
    'Classes begin on 1 October 2027.',
    'Predicted grades are not accepted; only final school leaving certificates.',
    'Applicants must hold an English B2 certificate: IELTS Academic 6.0 or TOEFL iBT 87.',
    'No entrance examination is required.',
    'Candidates with a mathematics and physics school profile are admitted directly.',
  ].join('\n');

function fields(
  programId: string,
  url: string,
  overrides: Partial<ProgramSpecNodeFields> = {},
): ProgramSpecNodeFields {
  return {
    program_id: programId,
    admission_season: SEASON,
    tuition_annual_eur: 6000,
    scholarship_waiver_codes_json: [],
    accepted_prior_fields_json: { exact: ['MATH_PHYSICS', 'STEM_QRUP_1'], adjacent: [] },
    predicted_grades_accepted: false,
    min_gpa_100: null,
    min_math_100: null,
    high_school_emi_accepted: false,
    min_bsc_emi_pct: null,
    min_english_requirements_json: {
      min_cefr: 'B2',
      accepted_tests: [
        { exam: 'IELTS_ACADEMIC', min_score: 6, valid_from: null, valid_until: null },
        { exam: 'TOEFL_IBT', min_score: 87, valid_from: null, valid_until: null },
      ],
      rejected_tests: [],
      other_accepted: [],
    },
    required_entrance_exams_json: [],
    schooling_11yr_override: null,
    app_window_open_at: null,
    app_window_close_at: '2027-07-15T23:59:00+02:00',
    qualified_docs_deadline_at: null,
    classes_start_date: '2027-10-01',
    official_portal_fee_eur_cents: null,
    program_requirements_json: { core_modules: ['Algorithms', 'Operating Systems'] },
    program: {
      id: programId,
      university_id: UNIVERSITY_ID,
      name_en: 'Computer Science',
      name_local: null,
      degree_level: 'BACHELOR',
      field_code: 'CS_IT',
      instruction_language: 'en',
      duration_semesters: 7,
      ects_total: 210,
      official_program_url: url,
    },
    ...overrides,
  };
}

function cite(snapshotId: string, url: string, field_path: string, verbatim_quote: string) {
  return { field_path, snapshot_id: snapshotId, source_url: url, verbatim_quote, retrieved_at: RETRIEVED };
}

function proposal(
  programId: string,
  snapshotId: string,
  url: string,
  f: ProgramSpecNodeFields,
  quotes: Record<string, string>,
): WikiNodeProposal {
  return {
    layer: 'PROGRAM_SPEC',
    node_key: `${programId}:${SEASON}`,
    fields: f,
    slot_completeness: { program_deadlines_and_fees: { status: 'VERIFIED_CURRENT', season: '2027-2028' } },
    abstain_fields: [],
    citations: Object.entries(quotes).map(([path, quote]) => cite(snapshotId, url, path, quote)),
  };
}

const GOOD_QUOTES = {
  tuition_annual_eur: 'Tuition fee for non-EU students: EUR 6 000 per year.',
  app_window_close_at: 'Application deadline for non-EU candidates: 15 July 2027',
  predicted_grades_accepted: 'Predicted grades are not accepted',
  min_english_requirements_json:
    'Applicants must hold an English B2 certificate: IELTS Academic 6.0 or TOEFL iBT 87.',
};

const pass = (score: number): VerificationReport => ({
  verification_score: score,
  checked_paths: [...LAYERS.PROGRAM_SPEC.requiredPaths],
  discrepancies: [],
});

export interface ScenarioRound {
  readonly proposal: WikiNodeProposal;
  /** Agent B output (absent when the validator rejects the round: Agent B is never called). */
  readonly report?: VerificationReport;
}

export interface Scenario {
  readonly name: string;
  readonly programId: string;
  readonly targetKey: string;
  readonly snapshotId: string;
  readonly url: string;
  readonly text: string;
  readonly fetchedAt: Date;
  /** Pre-existing node (inserted before the workflow runs). */
  readonly existing?: { readonly fields: ProgramSpecNodeFields; readonly lockedPaths: readonly string[] };
  readonly rounds: readonly ScenarioRound[];
}

function scenario(
  name: string,
  snapshotId: string,
  build: (s: {
    programId: string;
    url: string;
  }) => Omit<Scenario, 'name' | 'programId' | 'targetKey' | 'snapshotId' | 'url' | 'fetchedAt'>,
): Scenario {
  const programId = `${UNIVERSITY_ID}:bsc-${name}`;
  const url = `https://${HOST}/t2verify/${name}`;
  return {
    name,
    programId,
    targetKey: `${programId}:${SEASON}`,
    snapshotId,
    url,
    fetchedAt: new Date(RETRIEVED),
    ...build({ programId, url }),
  };
}

export const SCENARIOS = {
  /** Valid snapshot + valid Agent A + passing Agent B (0.97) -> DEEP_VERIFIED + revision + 4 cards. */
  good: scenario('good', '0193f2a0-0000-7000-8000-000000000001', ({ programId, url }) => ({
    text: PAGE('6 000'),
    rounds: [
      {
        proposal: proposal(
          programId,
          '0193f2a0-0000-7000-8000-000000000001',
          url,
          fields(programId, url),
          GOOD_QUOTES,
        ),
        report: pass(0.97),
      },
    ],
  })),
  /** Seeded error #1: Agent A cites a quote that is not in the snapshot (both rounds) -> QUARANTINED, 0 Agent B calls. */
  halluc: scenario('halluc', '0193f2a0-0000-7000-8000-000000000002', ({ programId, url }) => {
    const sid = '0193f2a0-0000-7000-8000-000000000002';
    const bad = {
      ...GOOD_QUOTES,
      tuition_annual_eur: 'Tuition fee for non-EU students: EUR 3 000 per year.',
    };
    const f = fields(programId, url, { tuition_annual_eur: 3000 });
    return {
      text: PAGE('6 000'),
      rounds: [
        { proposal: proposal(programId, sid, url, f, bad) },
        { proposal: proposal(programId, sid, url, f, bad) },
      ],
    };
  }),
  /** Seeded error #2: Agent A uses the EU deadline; Agent B flags EU_VS_NONEU (0.70) in both rounds -> QUARANTINED. */
  euvsnoneu: scenario('euvsnoneu', '0193f2a0-0000-7000-8000-000000000003', ({ programId, url }) => {
    const sid = '0193f2a0-0000-7000-8000-000000000003';
    const f = fields(programId, url, { app_window_close_at: '2027-08-31T23:59:00+02:00' });
    const quotes = { ...GOOD_QUOTES, app_window_close_at: 'EU candidates may apply until 31 August 2027.' };
    const flagged: VerificationReport = {
      verification_score: 0.7,
      checked_paths: [...LAYERS.PROGRAM_SPEC.requiredPaths],
      discrepancies: [
        {
          field_path: 'app_window_close_at',
          kind: 'EU_VS_NONEU',
          detail: '31 August 2027 is the EU deadline; the Non-EU deadline is 15 July 2027.',
        },
      ],
    };
    return {
      text: PAGE('6 000'),
      rounds: [
        { proposal: proposal(programId, sid, url, f, quotes), report: flagged },
        { proposal: proposal(programId, sid, url, f, quotes), report: flagged },
      ],
    };
  }),
  /** Seeded error #3: tuition is LOCKED_BY_HUMAN at 4000; Agent A proposes 9999 -> pinned value kept + lockConflicts. */
  locked: scenario('locked', '0193f2a0-0000-7000-8000-000000000004', ({ programId, url }) => {
    const sid = '0193f2a0-0000-7000-8000-000000000004';
    const proposed = fields(programId, url, { tuition_annual_eur: 9999 });
    const quotes = {
      ...GOOD_QUOTES,
      tuition_annual_eur: 'Tuition fee for non-EU students: EUR 9 999 per year.',
    };
    return {
      text: PAGE('9 999'),
      existing: {
        fields: fields(programId, url, { tuition_annual_eur: 4000 }),
        lockedPaths: ['tuition_annual_eur'],
      },
      rounds: [{ proposal: proposal(programId, sid, url, proposed, quotes), report: pass(0.98) }],
    };
  }),
} as const satisfies Record<string, Scenario>;

export function targetOf(s: Scenario): NodeTarget {
  return { layer: 'PROGRAM_SPEC', nodeKey: s.targetKey, season: SEASON, targetKey: s.targetKey };
}

export function gatheredOf(s: Scenario): Gathered {
  return {
    documents: [
      {
        snapshotId: s.snapshotId,
        requestedUrl: s.url,
        finalUrl: s.url,
        kind: 'web',
        text: s.text,
        retrievedAt: s.fetchedAt.toISOString(),
      },
    ],
    slots: {},
    healed: [],
  };
}

export function existingViewOf(s: Scenario): ExistingView | null {
  if (s.existing === undefined) return null;
  return {
    version: 1,
    depth: 'BASELINE',
    lockedPaths: s.existing.lockedPaths,
    fields: { ...s.existing.fields },
  };
}

const IDS = { idempotencyKey: 'synthesis', callKey: 'synthesis' };

/**
 * Builds every cassette the 4 scenarios need, by replaying the workflow's decision logic offline. Identical
 * calls share one cassette (e.g. Agent B sees the same input in both rounds of `euvsnoneu`).
 */
export function synthesizeCassettes(): Cassette[] {
  const byKey = new Map<string, Cassette>();
  const out = {
    push(c: Cassette): void {
      const prior = byKey.get(c.key);
      byKey.set(
        c.key,
        prior === undefined
          ? c
          : { ...prior, note: `${prior.note} + ${c.note.replace(/^curator-verify /, '')}` },
      );
    },
  };
  const all: readonly Scenario[] = Object.values(SCENARIOS);
  for (const s of all) {
    const target = targetOf(s);
    const gathered = gatheredOf(s);
    const existing = existingViewOf(s);
    let feedback: string | null = null;
    for (const [i, round] of s.rounds.entries()) {
      const extract = buildExtractCall('RTE-wiki.deep_extract', target, gathered, feedback, IDS);
      const aMaterial = cassetteMaterialFor(extract, 'gg.pro');
      out.push({
        key: cassetteKey(aMaterial),
        material: aMaterial,
        note: `curator-verify ${s.name} round ${i + 1}: Agent A (deep_extract, gg.pro)`,
        response: {
          kind: 'GENERATE',
          text: JSON.stringify(round.proposal),
          inputTokens: 2_400,
          outputTokens: 900,
        },
      });
      const validated: Validated = validateNodeProposal(
        target,
        round.proposal,
        gathered,
        existing,
        isAllowlistedForScenarios,
        NOW,
      );
      if (validated.errors.length > 0 || validated.fields === null) {
        feedback = retryFeedback(
          validated,
          gateDecision(target, validated, round.proposal, undefined),
          undefined,
        );
        continue;
      }
      if (round.report === undefined)
        throw new Error(`${s.name} round ${i + 1}: validator passed but no Agent B report scripted`);
      const verify = buildVerifyCall(
        target,
        gathered,
        round.proposal,
        validated.fields,
        'google-gemini',
        IDS,
      );
      const bMaterial = cassetteMaterialFor(verify, 'oa.flagship');
      out.push({
        key: cassetteKey(bMaterial),
        material: bMaterial,
        note: `curator-verify ${s.name} round ${i + 1}: Agent B (deep_verify, oa.flagship, excludes google-gemini)`,
        response: {
          kind: 'GENERATE',
          text: JSON.stringify(round.report),
          inputTokens: 2_900,
          outputTokens: 300,
        },
      });
      feedback = retryFeedback(
        validated,
        gateDecision(target, validated, round.proposal, round.report),
        round.report,
      );
    }
  }
  return [...byKey.values()];
}

/** Agent A's fields of the `good` scenario (a complete, valid PROGRAM_SPEC node). */
export function goodFields(): Record<string, unknown> {
  const round = SCENARIOS.good.rounds[0];
  if (round === undefined) throw new Error('good scenario has no round');
  return { ...round.proposal.fields };
}
