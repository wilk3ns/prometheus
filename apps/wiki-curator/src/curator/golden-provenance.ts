import type { WikiLayer } from '@prometheus/contracts';
import type { GoldenPlan, UncitedBasisCode } from './golden-mapping.js';
import { pathsOverlap } from './paths.js';

/**
 * Golden provenance report (review cycle 2, MEDIUM-2): every required golden value that carries no verbatim
 * citation on its own node, with the exact basis of the value and whether the $0 matcher reads it. Pure: it
 * runs on mapped plans, writes nothing, and is meant to go to the Architect for ratification.
 */

/**
 * Columns the deterministic matcher (apps/core `l1-rules.ts` + its SQL read model) reads per layer. Kept here
 * because the curator may not import apps/core; a change to the matcher's inputs must update this list.
 */
export const MATCHER_INPUT_PATHS: Readonly<Record<WikiLayer, readonly string[]>> = {
  COUNTRY: [],
  CITY: ['monthly_living_min_eur', 'minor_consents_json'],
  ORIGIN_EQUIVALENCY: [
    'equivalency_policy',
    'national_recognition_lead_days',
    'ru_sector_translation_exempt',
    'minor_consents_json',
  ],
  UNIVERSITY: ['country_iso2', 'credit_card_accepted', 'minor_consents_json'],
  HOUSING: ['monthly_min_eur'],
  PROGRAM_SPEC: [
    'tuition_annual_eur',
    'scholarship_waiver_codes_json',
    'accepted_prior_fields_json',
    'predicted_grades_accepted',
    'min_gpa_100',
    'high_school_emi_accepted',
    'min_bsc_emi_pct',
    'min_english_requirements_json',
    'required_entrance_exams_json',
    'schooling_11yr_override',
    'app_window_close_at',
    'qualified_docs_deadline_at',
    'classes_start_date',
    'program.degree_level',
    'program.instruction_language',
  ],
};

export interface ProvenanceEntry {
  readonly file: string;
  readonly layer: WikiLayer;
  readonly nodeKey: string;
  readonly path: string;
  readonly basis: UncitedBasisCode;
  readonly source: string;
  readonly matcherInput: boolean;
  /** Not an Architect ruling: needs explicit ratification. */
  readonly pendingRatification: boolean;
}

export interface ProvenanceReport {
  readonly report: 'golden-provenance-v1';
  readonly files: readonly string[];
  readonly totals: Readonly<Record<UncitedBasisCode, number>>;
  readonly matcherInputsPendingRatification: number;
  readonly entries: readonly ProvenanceEntry[];
}

const PENDING: ReadonlySet<UncitedBasisCode> = new Set(['FIXTURE_VALUE_UNCITED', 'PROVISIONAL_D_N']);

export function goldenProvenanceReport(plans: readonly GoldenPlan[]): ProvenanceReport {
  const entries: ProvenanceEntry[] = [];
  for (const plan of plans) {
    for (const node of plan.nodes) {
      for (const u of node.uncitedBasis) {
        entries.push({
          file: plan.file,
          layer: node.layer,
          nodeKey: node.nodeKey,
          path: u.path,
          basis: u.basis,
          source: u.source,
          matcherInput: MATCHER_INPUT_PATHS[node.layer].some((m) => pathsOverlap(m, u.path)),
          pendingRatification: PENDING.has(u.basis),
        });
      }
    }
  }
  // matcher-critical, unratified values first: that is the list the Architect must look at
  entries.sort(
    (a, b) =>
      Number(b.pendingRatification && b.matcherInput) - Number(a.pendingRatification && a.matcherInput) ||
      a.file.localeCompare(b.file) ||
      a.nodeKey.localeCompare(b.nodeKey) ||
      a.path.localeCompare(b.path),
  );
  const totals: Record<UncitedBasisCode, number> = {
    FIXTURE_VALUE_UNCITED: 0,
    RULING_B3: 0,
    RULING_D_A: 0,
    RULING_D_F: 0,
    SPEC_G7: 0,
    PROVISIONAL_D_N: 0,
  };
  for (const e of entries) totals[e.basis] += 1;
  return {
    report: 'golden-provenance-v1',
    files: plans.map((p) => p.file),
    totals,
    matcherInputsPendingRatification: entries.filter((e) => e.pendingRatification && e.matcherInput).length,
    entries,
  };
}
