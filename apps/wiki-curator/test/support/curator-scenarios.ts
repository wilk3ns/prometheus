import { fileURLToPath } from 'node:url';
import type {
  OriginEquivalencyFields,
  ProgramSpecNodeFields,
  VerificationReport,
  WikiLayer,
  WikiNodeProposal,
} from '@prometheus/contracts';
import { cassetteKey, cassetteMaterialFor, type Cassette } from '@prometheus/ai';
import { LAYERS } from '../../src/curator/layers.js';
import {
  buildExtractCall,
  buildVerifyCall,
  gateDecision,
  retryFeedback,
  validateNodeProposal,
  type Gathered,
  type NodeContext,
  type NodeTarget,
  type Validated,
} from '../../src/curator/pipeline.js';

/**
 * Synthetic, fully deterministic curator scenarios for curator-verify.it.ts ([T2-G5], review cycle 2).
 * Each scenario fixes the official snapshot (id, URL, text, fetch time), the crawl target (layer, BOUND node
 * key, country), the scripted Agent A / Agent B outputs per round, and any pre-existing node.
 * `synthesizeCassettes()` builds the replay cassettes with the SAME pure call builders, validators and gates
 * the workflows use, so the committed cassettes (repo `cassettes/`) key exactly to the live calls.
 */

export const SEASON = '2027-FALL';
export const UNIVERSITY_ID = 't2verify';
export const CITY_ID = 'PL-T2VERIFY';
export const HOST = 'www.pw.edu.pl';
export const CASSETTE_DIR = fileURLToPath(new URL('../../../../cassettes/', import.meta.url));

export const isAllowlistedForScenarios = (url: URL): boolean =>
  url.hostname === 'pw.edu.pl' || url.hostname.endsWith('.pw.edu.pl');

const RETRIEVED = '2026-11-20T10:00:00.000Z';

const PAGE = (tuition: string) =>
  [
    'T2 Verify University of Technology - Computer Science (B.Sc.), taught in English.',
    `Tuition fee for non-EU students: EUR ${tuition} per year.`,
    'No tuition waivers or scholarships are offered to non-EU Bachelor candidates.',
    'Application deadline for non-EU candidates: 15 July 2027 (23:59 CEST).',
    'EU candidates may apply until 31 August 2027.',
    'Classes begin on 1 October 2027.',
    'Predicted grades are not accepted; only final school leaving certificates.',
    'Applicants must hold an English B2 certificate: IELTS Academic 6.0 or TOEFL iBT 87.',
    'No entrance examination is required.',
    'Candidates with a mathematics and physics school profile are admitted directly.',
  ].join('\n');

const ORIGIN_PAGE = [
  'Admission of holders of foreign school qualifications.',
  'International Baccalaureate holders are admitted directly to Bachelor programmes.',
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

/** One verbatim quote per required PROGRAM_SPEC path (P1: every required path cited). */
const GOOD_QUOTES: Readonly<Record<string, string>> = {
  tuition_annual_eur: 'Tuition fee for non-EU students: EUR 6 000 per year.',
  scholarship_waiver_codes_json:
    'No tuition waivers or scholarships are offered to non-EU Bachelor candidates.',
  accepted_prior_fields_json:
    'Candidates with a mathematics and physics school profile are admitted directly.',
  predicted_grades_accepted: 'Predicted grades are not accepted',
  min_english_requirements_json:
    'Applicants must hold an English B2 certificate: IELTS Academic 6.0 or TOEFL iBT 87.',
  required_entrance_exams_json: 'No entrance examination is required.',
  app_window_close_at: 'Application deadline for non-EU candidates: 15 July 2027',
  // the ancestor path covers program.degree_level and program.instruction_language
  program: 'T2 Verify University of Technology - Computer Science (B.Sc.), taught in English.',
};

function proposal(
  layer: WikiLayer,
  nodeKey: string,
  snapshotId: string,
  url: string,
  f: Record<string, unknown>,
  quotes: Readonly<Record<string, string>>,
  abstain: readonly string[] = [],
): WikiNodeProposal {
  return {
    layer,
    node_key: nodeKey,
    fields: f,
    slot_completeness: { program_deadlines_and_fees: { status: 'VERIFIED_CURRENT', season: '2027-2028' } },
    abstain_fields: [...abstain],
    citations: Object.entries(quotes).map(([field_path, verbatim_quote]) => ({
      field_path,
      snapshot_id: snapshotId,
      source_url: url,
      verbatim_quote,
      // deliberately NOT the snapshot time: the validator must overwrite it (LOW-3)
      retrieved_at: '2026-11-26T00:00:00.000Z',
    })),
  };
}

const pass = (score: number): VerificationReport => ({
  verification_score: score,
  checked_paths: [...LAYERS.PROGRAM_SPEC.requiredPaths],
  discrepancies: [],
});

export interface ScenarioRound {
  readonly proposal: WikiNodeProposal;
  /** Agent B output (absent when the validator rejects the round, and for WF-19). */
  readonly report?: VerificationReport;
}

export interface Scenario {
  readonly name: string;
  readonly workflow: 'WF-03' | 'WF-19';
  readonly layer: WikiLayer;
  readonly targetKey: string;
  /** Node key BOUND to the target (never taken from model output). */
  readonly nodeKey: string;
  readonly countryIso2: string;
  /** Programme id for PROGRAM_SPEC scenarios. */
  readonly programId: string;
  readonly snapshotId: string;
  readonly url: string;
  readonly text: string;
  readonly fetchedAt: Date;
  /** Pre-existing node (inserted before the workflow runs). */
  readonly existing?: { readonly fields: ProgramSpecNodeFields; readonly lockedPaths: readonly string[] };
  readonly rounds: readonly ScenarioRound[];
}

function programScenario(
  name: string,
  workflow: Scenario['workflow'],
  snapshotId: string,
  build: (s: {
    programId: string;
    nodeKey: string;
    url: string;
  }) => Pick<Scenario, 'text' | 'rounds'> & Partial<Pick<Scenario, 'existing'>>,
): Scenario {
  const programId = `${UNIVERSITY_ID}:bsc-${name}`;
  const nodeKey = `${programId}:${SEASON}`;
  const url = `https://${HOST}/t2verify/${name}`;
  return {
    name,
    workflow,
    layer: 'PROGRAM_SPEC',
    targetKey: nodeKey,
    nodeKey,
    countryIso2: 'PL',
    programId,
    snapshotId,
    url,
    fetchedAt: new Date(RETRIEVED),
    ...build({ programId, nodeKey, url }),
  };
}

const sid = (n: number) => `0193f2a0-0000-7000-8000-${String(n).padStart(12, '0')}`;

const FOREIGN_ORIGIN: OriginEquivalencyFields = {
  destination_country_iso2: 'PL',
  citizenship_country: '**',
  diploma_origin_country: '**',
  diploma_type: 'IB',
  admission_season: SEASON,
  equivalency_policy: 'DIRECT',
  national_recognition_lead_days: 0,
  ru_sector_translation_exempt: false,
  paper_apostille_accepted: true,
  e_apostille_accepted: true,
  minor_consents_json: [],
  legalization_rules_json: {},
};

export const SCENARIOS = {
  /** WF-03: valid snapshot + valid Agent A + passing Agent B (0.97) -> DEEP_VERIFIED + revision + 4 cards. */
  good: programScenario('good', 'WF-03', sid(1), ({ programId, nodeKey, url }) => ({
    text: PAGE('6 000'),
    rounds: [
      {
        proposal: proposal('PROGRAM_SPEC', nodeKey, sid(1), url, fields(programId, url), GOOD_QUOTES),
        report: pass(0.97),
      },
    ],
  })),
  /** WF-03 seeded error #1: hallucinated tuition quote (both rounds) -> QUARANTINED, 0 Agent B calls. */
  halluc: programScenario('halluc', 'WF-03', sid(2), ({ programId, nodeKey, url }) => {
    const bad = {
      ...GOOD_QUOTES,
      tuition_annual_eur: 'Tuition fee for non-EU students: EUR 3 000 per year.',
    };
    const f = fields(programId, url, { tuition_annual_eur: 3000 });
    const p = proposal('PROGRAM_SPEC', nodeKey, sid(2), url, f, bad);
    return { text: PAGE('6 000'), rounds: [{ proposal: p }, { proposal: p }] };
  }),
  /** WF-03 seeded error #2: EU deadline; Agent B flags EU_VS_NONEU (0.70) in both rounds -> QUARANTINED. */
  euvsnoneu: programScenario('euvsnoneu', 'WF-03', sid(3), ({ programId, nodeKey, url }) => {
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
    const p = proposal('PROGRAM_SPEC', nodeKey, sid(3), url, f, quotes);
    return {
      text: PAGE('6 000'),
      rounds: [
        { proposal: p, report: flagged },
        { proposal: p, report: flagged },
      ],
    };
  }),
  /** WF-03 seeded error #3: tuition LOCKED_BY_HUMAN at 4000; Agent A proposes 9999 -> pin kept + lockConflicts. */
  locked: programScenario('locked', 'WF-03', sid(4), ({ programId, nodeKey, url }) => ({
    text: PAGE('9 999'),
    existing: {
      fields: fields(programId, url, { tuition_annual_eur: 4000 }),
      lockedPaths: ['tuition_annual_eur'],
    },
    rounds: [
      {
        proposal: proposal(
          'PROGRAM_SPEC',
          nodeKey,
          sid(4),
          url,
          fields(programId, url, { tuition_annual_eur: 9999 }),
          {
            ...GOOD_QUOTES,
            tuition_annual_eur: 'Tuition fee for non-EU students: EUR 9 999 per year.',
          },
        ),
        report: pass(0.98),
      },
    ],
  })),
  /** WF-19 P1: every required path cited -> BASELINE + ACTIVE. */
  baseok: programScenario('baseok', 'WF-19', sid(5), ({ programId, nodeKey, url }) => ({
    text: PAGE('6 000'),
    rounds: [
      { proposal: proposal('PROGRAM_SPEC', nodeKey, sid(5), url, fields(programId, url), GOOD_QUOTES) },
    ],
  })),
  /**
   * WF-19 reviewer probe (HIGH-1): placeholder tuition 0 backed by ONE unrelated genuine quote, and an abstention
   * on the PARENT path `program` -> REQUIRED_PATH_UNCITED + abstained required paths -> never ACTIVE.
   */
  baseabstain: programScenario('baseabstain', 'WF-19', sid(6), ({ programId, nodeKey, url }) => ({
    text: PAGE('6 000'),
    rounds: [
      {
        proposal: proposal(
          'PROGRAM_SPEC',
          nodeKey,
          sid(6),
          url,
          fields(programId, url, { tuition_annual_eur: 0 }),
          { required_entrance_exams_json: 'No entrance examination is required.' },
          ['program'],
        ),
      },
    ],
  })),
  /**
   * WF-19 reviewer probe (HIGH-2): an IT origin target whose bound node is `IT:AZ:AZ:BACHELOR_DEGREE`; Agent A
   * proposes the foreign wildcard rule `PL:**:**:IB` backed by a genuine quote -> rejected, NO row written.
   */
  foreignorigin: ((): Scenario => {
    const url = `https://${HOST}/t2verify/origin-rules`;
    const nodeKey = `IT:AZ:AZ:BACHELOR_DEGREE:${SEASON}`;
    return {
      name: 'foreignorigin',
      workflow: 'WF-19',
      layer: 'ORIGIN_EQUIVALENCY',
      targetKey: `t2verify:origin-az-bachelor:${SEASON}`,
      nodeKey,
      countryIso2: 'IT',
      programId: '',
      snapshotId: sid(7),
      url,
      text: ORIGIN_PAGE,
      fetchedAt: new Date(RETRIEVED),
      rounds: [
        {
          proposal: proposal(
            'ORIGIN_EQUIVALENCY',
            `PL:**:**:IB:${SEASON}`,
            sid(7),
            url,
            { ...FOREIGN_ORIGIN },
            {
              equivalency_policy:
                'International Baccalaureate holders are admitted directly to Bachelor programmes.',
            },
          ),
        },
      ],
    };
  })(),
} as const satisfies Record<string, Scenario>;

export function targetOf(s: Scenario): NodeTarget {
  return {
    layer: s.layer,
    nodeKey: s.nodeKey,
    season: SEASON,
    targetKey: s.targetKey,
    countryIso2: s.countryIso2,
  };
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

/** Stored context the workflow will load (the t2verify university is a PL BASELINE row seeded beforehand). */
export function contextOf(s: Scenario): NodeContext {
  return {
    existing:
      s.existing === undefined
        ? null
        : {
            version: 1,
            depth: 'BASELINE',
            lockedPaths: s.existing.lockedPaths,
            fields: { ...s.existing.fields },
          },
    universityCountry: s.layer === 'PROGRAM_SPEC' || s.layer === 'HOUSING' ? 'PL' : null,
  };
}

const IDS = { idempotencyKey: 'synthesis', callKey: 'synthesis' };

/**
 * Builds every cassette the scenarios need, by replaying the workflows' decision logic offline. Identical
 * calls share one cassette (e.g. Agent B sees the same input in both rounds of `euvsnoneu`).
 */
export function synthesizeCassettes(): Cassette[] {
  const byKey = new Map<string, Cassette>();
  const push = (c: Cassette): void => {
    const prior = byKey.get(c.key);
    byKey.set(
      c.key,
      prior === undefined
        ? c
        : { ...prior, note: `${prior.note} + ${c.note.replace(/^curator-verify /, '')}` },
    );
  };
  const all: readonly Scenario[] = Object.values(SCENARIOS);
  for (const s of all) {
    const target = targetOf(s);
    const gathered = gatheredOf(s);
    const context = contextOf(s);
    if (s.workflow === 'WF-19') {
      const round = s.rounds[0];
      if (round === undefined) throw new Error(`${s.name}: no round`);
      const material = cassetteMaterialFor(
        buildExtractCall('RTE-wiki.baseline_extract', target, gathered, null, IDS),
        'gg.flash',
      );
      push({
        key: cassetteKey(material),
        material,
        note: `curator-verify ${s.name}: WF-19 baseline_extract (gg.flash)`,
        response: {
          kind: 'GENERATE',
          text: JSON.stringify(round.proposal),
          inputTokens: 2_000,
          outputTokens: 700,
        },
      });
      continue;
    }
    let feedback: string | null = null;
    for (const [i, round] of s.rounds.entries()) {
      const aMaterial = cassetteMaterialFor(
        buildExtractCall('RTE-wiki.deep_extract', target, gathered, feedback, IDS),
        'gg.pro',
      );
      push({
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
        context,
        isAllowlistedForScenarios,
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
      const bMaterial = cassetteMaterialFor(
        buildVerifyCall(target, gathered, round.proposal, validated.fields, 'google-gemini', IDS),
        'oa.flagship',
      );
      push({
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
