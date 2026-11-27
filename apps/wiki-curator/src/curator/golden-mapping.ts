import {
  SlotStatus,
  type Citation,
  type SlotCompleteness,
  type VerificationDepth,
  type WikiLayer,
  type WikiStatus,
} from '@prometheus/contracts';
import type { FixtureNode } from './golden-fixture.js';
import { LAYERS } from './layers.js';

/**
 * ============================================================================================================
 *  GOLDEN FIXTURE -> wiki-v2.0 COLUMN MAPPING  (the ONLY place fixture fields are interpreted)
 * ============================================================================================================
 * Every mapping decision is a single, labelled line referencing the ruling that authorises it:
 *   ENG-T2 §0.3 (COMM-ARCH-T2-RULINGS, 2026-11-27): B1 fixture citations · B2 nullable classes_start_date ·
 *   B3 accepted_prior_fields (now in the fixtures) · D-f alternatives as BASELINE · D-a..D-l defaults.
 *   [DERIVED]   = arithmetic / structural derivation from fixture values (named below).
 *   TODO_RULING = no source and no ruling: the import FAILS LOUDLY before any database write.
 * Mapping output is raw JSON records; the importer validates every node against the Zod layer schemas.
 * ============================================================================================================
 */

/** Id of a pending ruling (e.g. `B5`); none are pending since COMM-ARCH-T2-RULINGS + the B5 PRD resolution. */
export type RulingId = string;

export interface PendingRuling {
  readonly id: RulingId;
  /** Exact pointer: fixture file + JSON path + target column. */
  readonly pointer: string;
}

export class RulingLedger {
  readonly pending: PendingRuling[] = [];

  /**
   * TODO_RULING marker: records an unfillable NOT NULL column and yields no value. Any recorded marker makes
   * the import fail before the first write (golden-importer.ts), so nothing is ever invented.
   */
  TODO_RULING(id: RulingId, pointer: string): undefined {
    this.pending.push({ id, pointer });
    return undefined;
  }
}

export interface GoldenNode {
  readonly layer: WikiLayer;
  readonly nodeKey: string;
  /** Raw column record (validated by the importer against the layer schema). */
  readonly fields: Record<string, unknown>;
  readonly depth: VerificationDepth;
  readonly score: number | null;
  readonly citations: readonly Citation[];
  readonly slots: SlotCompleteness;
  readonly wikiStatus: WikiStatus | null;
  /**
   * P1 (golden provenance): required paths NOT carried by a fixture citation, each with the exact basis of its
   * value. The importer fails on any uncited required path missing here (and on stale entries).
   */
  readonly uncitedBasis: readonly UncitedBasis[];
}

export type UncitedBasisCode =
  'FIXTURE_VALUE_UNCITED' | 'RULING_B3' | 'RULING_D_A' | 'RULING_D_F' | 'SPEC_G7' | 'PROVISIONAL_D_N';

/** Why a required golden value carries no verbatim citation on its own node (MEDIUM-2, cycle 2: no overstatement). */
export interface UncitedBasis {
  readonly path: string;
  readonly basis: UncitedBasisCode;
  readonly source: string;
}

/**
 * Honest provenance for uncited required golden values. Only RULING_* codes are Architect rulings; the rest say
 * exactly what backs the value, and FIXTURE_VALUE_UNCITED / PROVISIONAL_D_N await Architect ratification
 * (`golden-provenance-report`).
 */
export const BASIS: Readonly<Record<UncitedBasisCode, string>> = {
  FIXTURE_VALUE_UNCITED:
    'Value present in the Architect-supplied golden fixture without a verbatim quote; imported per ENG-T2 §4 (golden import depth). Pending Architect ratification.',
  RULING_B3:
    'COMM-ARCH-T2-RULINGS B3: accepted_prior_fields lists ruled by the Architect and written into the fixture.',
  RULING_D_A: 'COMM-ARCH-T2-RULINGS D-a: NAWA statement policy maps to DIRECT_WITH_NATIONAL_STATEMENT.',
  RULING_D_F:
    'COMM-ARCH-T2-RULINGS D-f: comparator inherits the university-wide B.Sc. rules (BASELINE + ACTIVE, NULL score).',
  SPEC_G7:
    'ENG-T2 §6 Gate 7 states the scholarship values (PoliMi DSU_LOMBARDIA; WUT B.Sc. no scholarships).',
  PROVISIONAL_D_N:
    'D-n: builder mapping choice accepted PROVISIONALLY by the coordinator; NOT an Architect ruling. Pending confirmation.',
};

function ruled(basis: UncitedBasisCode, ...paths: string[]): UncitedBasis[] {
  return paths.map((path) => ({ path, basis, source: BASIS[basis] }));
}

export interface GoldenPlan {
  readonly file: string;
  readonly compiledKey: string;
  readonly season: string;
  /** Dependency order: country, city, origin, university, housing, programs. */
  readonly nodes: readonly GoldenNode[];
  readonly pending: readonly PendingRuling[];
}

// ---- shared helpers -------------------------------------------------------------------------------------

export type PricingTier = 'T1' | 'T2' | 'T3';

/**
 * B5 (resolved by the coordinator from the binding PRD): the Prometheus pricing tier follows the DESTINATION
 * COUNTRY, never the university. Source: vault `docs/01-product-requirements.md` L207 (Option C) -
 * "Tier 1 Turkey EUR 49, Tier 2 Poland/Hungary EUR 72, Tier 3 Italy/Germany EUR 95" (also docs/02 L117).
 */
const PRICING_TIER_BY_COUNTRY: Readonly<Record<string, PricingTier>> = {
  TR: 'T1',
  PL: 'T2',
  HU: 'T2',
  IT: 'T3',
  DE: 'T3',
};

export function pricingTierFor(countryIso2: string): PricingTier {
  const tier = PRICING_TIER_BY_COUNTRY[countryIso2];
  if (tier === undefined) throw new RangeError(`no pricing tier for destination country ${countryIso2}`);
  return tier;
}

/** `2027-FALL:polimi:msc-cse:AZ:AZ:BACHELOR_DEGREE` -> season `2027-FALL`. */
function seasonOf(compiledKey: string): string {
  const season = compiledKey.split(':')[0] ?? '';
  if (!/^\d{4}-(FALL|SPRING)$/.test(season))
    throw new RangeError(`compiled_key ${compiledKey} has no season prefix`);
  return season;
}

/** D-e: verification_score = overall_completeness_pct / 100 (fixtures carry no separate score). */
function scoreOf(f: FixtureNode): number {
  return f.at('verification_meta').num('overall_completeness_pct') / 100;
}

/** Citation path: fixture path -> typed column when aliased, else `<payload column>.<fixture path>`. */
function pathMapper(payloadColumn: string, aliases: Readonly<Record<string, string>> = {}) {
  return (fixturePath: string): string => aliases[fixturePath] ?? `${payloadColumn}.${fixturePath}`;
}

/** Fixture slot keys -> the layer node that owns them (verification_meta.slot_completeness). */
function slotsFor(
  f: FixtureNode,
  owners: Readonly<Record<string, WikiLayer>>,
  layer: WikiLayer,
): SlotCompleteness {
  const all = f.at('verification_meta').at('slot_completeness');
  const out: Record<string, SlotCompleteness[string]> = {};
  for (const [key, owner] of Object.entries(owners)) {
    if (owner !== layer) continue;
    const slot = all.at(key);
    out[key] = {
      status: SlotStatus.parse(slot.str('status')),
      ...(slot.has('season') ? { season: slot.str('season') } : {}),
      ...(slot.has('expected_refresh_month')
        ? { expected_refresh_month: slot.str('expected_refresh_month') }
        : {}),
      ...(slot.has('note') ? { note: slot.str('note') } : {}),
    };
  }
  return out;
}

const PRIMARY = { depth: 'DEEP_VERIFIED' as const };

// ---- PoliMi MSc CSE 2027 --------------------------------------------------------------------------------

const POLIMI_SLOT_OWNERS: Readonly<Record<string, WikiLayer>> = {
  program_deadlines_and_fees: 'PROGRAM_SPEC',
  admission_documents_and_portal_limits: 'PROGRAM_SPEC',
  english_requirements: 'PROGRAM_SPEC',
  origin_az_equivalency_and_apostille: 'ORIGIN_EQUIVALENCY',
  non_eu_seat_quotas: 'PROGRAM_SPEC',
  university_tuition_non_eu: 'UNIVERSITY',
  dsu_scholarship_amounts_and_lease_rules: 'UNIVERSITY',
  city_profile_milan: 'CITY',
  university_housing_milan_dorms: 'HOUSING',
  cse_specific_ects_prerequisite_table: 'PROGRAM_SPEC',
};

function mapPolimi(f: FixtureNode, file: string): GoldenNode[] {
  const season = seasonOf(f.str('compiled_key'));
  const score = scoreOf(f);
  const l1 = f.at('layer_1_country');
  const l1b = f.at('layer_1b_city_profile');
  const l2 = f.at('layer_2_origin_equivalency');
  const l3 = f.at('layer_3_university');
  const l3b = f.at('layer_3b_university_housing');
  const l4 = f.at('layer_4_program_season_spec');
  const budget = l1b.at('monthly_student_budget_eur');
  const tuition = l3.at('tuition_non_eu_msc');
  const english = l4.at('english_requirements');
  const tests = english.at('accepted_tests');
  const calls = l4.list('calls_non_eu_abroad');
  const firstCall = calls[0];
  const lastCall = calls[calls.length - 1];
  if (firstCall === undefined || lastCall === undefined) throw new RangeError(`${file}: no Non-EU calls`);
  const slots = (layer: WikiLayer) => slotsFor(f, POLIMI_SLOT_OWNERS, layer);

  const country: GoldenNode = {
    layer: 'COUNTRY',
    nodeKey: `${l1.str('country_iso2')}:${season}`,
    fields: {
      country_iso2: l1.str('country_iso2'),
      admission_season: season,
      rules_payload_json: l1.objectWithout('citations'),
    },
    ...PRIMARY,
    score,
    citations: l1.citations(pathMapper('rules_payload_json')), // B1
    slots: slots('COUNTRY'),
    uncitedBasis: [],
    wikiStatus: null,
  };

  const cityId = l1b.str('city_id');
  const city: GoldenNode = {
    layer: 'CITY',
    nodeKey: cityId,
    fields: {
      id: cityId,
      country_iso2: l1b.str('country_iso2'),
      city_name_en: l1b.str('city_name_en'),
      // D-g [DERIVED]: sum of the component minima / maxima of monthly_student_budget_eur (682 / 1152)
      monthly_living_min_eur:
        budget.num('accommodation_min') +
        budget.num('food_groceries_min') +
        budget.num('transport_under_27') +
        budget.num('mobile_sim_min') +
        budget.num('social_life_min'),
      monthly_living_max_eur:
        budget.num('accommodation_max') +
        budget.num('food_groceries_max') +
        budget.num('transport_under_27') +
        budget.num('mobile_sim_max') +
        budget.num('social_life_max'),
      minor_consents_json: [], // fixture lists no <18 consent for Milan
      attributes_json: l1b.objectWithout('citations', 'city_id', 'city_name_en', 'country_iso2'),
    },
    ...PRIMARY,
    score,
    citations: l1b.citations(pathMapper('attributes_json')),
    slots: slots('CITY'),
    uncitedBasis: ruled('FIXTURE_VALUE_UNCITED', 'city_name_en', 'minor_consents_json'),
    wikiStatus: null,
  };

  const authenticity = l2.at('authenticity_rules');
  const origin: GoldenNode = {
    layer: 'ORIGIN_EQUIVALENCY',
    nodeKey: [
      l2.str('destination_country_iso2'),
      l2.str('citizenship_country'),
      l2.str('diploma_origin_country'),
      l2.str('diploma_type'),
      season,
    ].join(':'),
    fields: {
      destination_country_iso2: l2.str('destination_country_iso2'),
      citizenship_country: l2.str('citizenship_country'),
      diploma_origin_country: l2.str('diploma_origin_country'),
      diploma_type: l2.str('diploma_type'),
      admission_season: season,
      equivalency_policy: l2.str('equivalency_policy'), // 'DIRECT'
      national_recognition_lead_days: 0, // no national recognition step for IT MSc
      // sworn translation required for az/ru originals
      ru_sector_translation_exempt: !l2.at('translation_rules').bool('sworn_translation_required_for_az_ru'),
      paper_apostille_accepted: authenticity.bool('paper_apostille_accepted'),
      // [DERIVED] accepted_methods lists the Azerbaijan Electronic Apostille
      e_apostille_accepted: authenticity.strings('accepted_methods').some((m) => /e-Apostille/i.test(m)),
      minor_consents_json: [],
      legalization_rules_json: l2.objectWithout('citations'),
    },
    ...PRIMARY,
    score,
    citations: l2.citations(
      pathMapper('legalization_rules_json', {
        'authenticity_rules.paper_apostille_accepted': 'paper_apostille_accepted',
      }),
    ),
    slots: slots('ORIGIN_EQUIVALENCY'),
    uncitedBasis: ruled(
      'FIXTURE_VALUE_UNCITED',
      'equivalency_policy',
      'national_recognition_lead_days',
      'ru_sector_translation_exempt',
      'e_apostille_accepted',
      'minor_consents_json',
    ),
    wikiStatus: null,
  };

  const uniId = l3.str('university_id');
  const university: GoldenNode = {
    layer: 'UNIVERSITY',
    nodeKey: uniId,
    fields: {
      id: uniId,
      name_en: l3.str('name_en'),
      name_local: null, // the official name is already Italian
      country_iso2: l1.str('country_iso2'),
      city_id: l3.str('city_id'),
      institution_type: l3.str('institution_type'),
      official_domain: l3.str('official_domain'),
      official_email_domains_json: l3.strings('official_email_domains'),
      primary_portal_type: 'DIRECT', // D-n: applications go through PoliMi Online Services (Universitaly is visa pre-enrolment)
      portal_url: l3.str('online_services_url'),
      sends_email_notifications: true, // column default; fixture silent
      credit_card_accepted: true, // column default; fixture silent (no BANK_TRANSFER_ONLY claim)
      pricing_tier_code: pricingTierFor(l1.str('country_iso2')), // B5: by destination country (ops-owned)
      minor_consents_json: [],
      general_rules_json: l3.objectWithout('citations'),
    },
    ...PRIMARY,
    score,
    citations: l3.citations(pathMapper('general_rules_json')),
    slots: slots('UNIVERSITY'),
    uncitedBasis: [
      ...ruled('FIXTURE_VALUE_UNCITED', 'institution_type', 'credit_card_accepted', 'minor_consents_json'),
      ...ruled('PROVISIONAL_D_N', 'primary_portal_type'),
    ],
    wikiStatus: null,
  };

  const critical = l3b.at('critical_rules');
  const housing: GoldenNode = {
    layer: 'HOUSING',
    nodeKey: `${uniId}:${l3b.str('rates_season')}`,
    fields: {
      university_id: uniId,
      rates_season: l3b.str('rates_season'),
      portal_url: l3b.str('portal_url'),
      official_info_url: l3b.str('official_info_url'),
      rate_pdf_url: l3b.str('rate_pdf_url'),
      total_places: l3b.num('total_system_places'),
      subsidized_places: l3b.num('dsu_subsidized_places_system'),
      monthly_min_eur: null, // D-g: only annual hall rates are published
      monthly_max_eur: null,
      non_refundable_on_visa_denial: critical.bool('non_refundable_on_visa_denial_or_non_enrolment'),
      critical_rules_json: l3b.objectWithout('citations', 'milan_halls'),
      halls_json: l3b.list('milan_halls').map((h) => h.objectWithout()),
    },
    ...PRIMARY,
    score,
    citations: l3b.citations(
      pathMapper('critical_rules_json', {
        'critical_rules.non_refundable_on_visa_denial_or_non_enrolment': 'non_refundable_on_visa_denial',
      }),
    ),
    slots: slots('HOUSING'),
    uncitedBasis: ruled('FIXTURE_VALUE_UNCITED', 'official_info_url', 'critical_rules_json'),
    wikiStatus: null,
  };

  const programId = l4.str('program_id');
  const deadlinesCitation = l4.list('citations').find((c) => c.str('field_path') === 'calls_non_eu_abroad');
  if (deadlinesCitation === undefined) throw new RangeError(`${file}: no calls_non_eu_abroad citation`);
  const program: GoldenNode = {
    layer: 'PROGRAM_SPEC',
    nodeKey: `${programId}:${season}`,
    fields: {
      program_id: programId,
      admission_season: season,
      tuition_annual_eur: Math.floor(tuition.num('annual_max_eur')), // D-b: 3943.04 -> 3943 (exact kept below)
      scholarship_waiver_codes_json: l4.strings('scholarship_waiver_codes'), // ['DSU_LOMBARDIA']
      accepted_prior_fields_json: l4.at('accepted_prior_fields').objectWithout(), // B3
      predicted_grades_accepted: l4.bool('predicted_grades_accepted'),
      min_gpa_100: l2.nullable('country_specific_min_gpa_100', (n) => Number(n.value)),
      min_math_100: null,
      high_school_emi_accepted: false, // MASTER programme: the EMI rule is min_bsc_emi_pct
      min_bsc_emi_pct: english.at('emi_exemption').num('min_courses_in_english_pct'), // 75
      min_english_requirements_json: {
        min_cefr: null, // PoliMi lists tests, not a CEFR level
        accepted_tests: [
          {
            exam: 'IELTS_ACADEMIC',
            min_score: tests.at('IELTS_ACADEMIC_OR_GENERAL').num('min_overall'),
            valid_from: null,
            valid_until: null,
          },
          {
            exam: 'IELTS_GENERAL',
            min_score: tests.at('IELTS_ACADEMIC_OR_GENERAL').num('min_overall'),
            valid_from: null,
            valid_until: null,
          },
          {
            exam: 'TOEFL_IBT',
            min_score: tests.at('TOEFL_IBT_UNTIL_2026_01_20').num('min_score'),
            valid_from: null,
            valid_until: '2026-01-20',
          },
          {
            exam: 'TOEFL_IBT',
            min_score: tests.at('TOEFL_IBT_FROM_2026_01_21').num('min_score'),
            valid_from: '2026-01-21',
            valid_until: null,
          },
          {
            exam: 'PTE_ACADEMIC',
            min_score: tests.at('PTE_ACADEMIC').num('min_score'),
            valid_from: null,
            valid_until: null,
          },
        ],
        rejected_tests: [],
        other_accepted: [
          ...tests.strings('CAMBRIDGE'),
          `TOEIC LR ${tests.at('TOEIC_AY_2027_2028_ONWARDS').num('min_lr')} / SW ${tests.at('TOEIC_AY_2027_2028_ONWARDS').num('min_sw')}`,
          `Trinity ${tests.str('TRINITY_ISE')}`,
          `LanguageCert ${tests.str('LANGUAGECERT_ESOL')}`,
        ],
      },
      required_entrance_exams_json: [], // no entrance exam (GRE optional)
      schooling_11yr_override: null,
      app_window_open_at: firstCall.str('open_at'), // D-c: first Non-EU call opens
      app_window_close_at: lastCall.str('close_at'), // D-c: final Non-EU call closes (2027-02-25)
      qualified_docs_deadline_at: null,
      classes_start_date: l4.nullable('classes_start_date', (n) => String(n.value)), // B2: NULL for PoliMi
      official_portal_fee_eur_cents: lastCall.num('official_app_fee_eur') * 100, // D-c: fee of the closing call
      program_requirements_json: {
        ...l4.objectWithout(
          'citations',
          'accepted_prior_fields',
          'predicted_grades_accepted',
          'scholarship_waiver_codes',
          'classes_start_date',
        ),
        tuition_exact_annual_max_eur: tuition.num('annual_max_eur'), // D-b
      },
      program: {
        id: programId,
        university_id: uniId,
        name_en: l4.str('name_en'),
        name_local: l4.str('name_local'),
        degree_level: l4.str('degree_level'),
        field_code: 'CS_IT', // D-n
        instruction_language: l4.str('instruction_language'),
        duration_semesters: l4.num('duration_years') * 2, // [DERIVED] 2 years
        ects_total: l4.num('ects_total'),
        official_program_url: deadlinesCitation.str('source_url'), // D-n: official Non-EU admission page
      },
    },
    ...PRIMARY,
    score,
    citations: l4.citations(
      pathMapper('program_requirements_json', {
        english_requirements: 'min_english_requirements_json',
        predicted_grades_accepted: 'predicted_grades_accepted',
        tuition_annual_eur: 'tuition_annual_eur',
        // D-c: the final Non-EU call close is app_window_close_at
        calls_non_eu_abroad: 'app_window_close_at',
      }),
    ),
    slots: slots('PROGRAM_SPEC'),
    uncitedBasis: [
      ...ruled('SPEC_G7', 'scholarship_waiver_codes_json'),
      ...ruled('RULING_B3', 'accepted_prior_fields_json'),
      ...ruled(
        'FIXTURE_VALUE_UNCITED',
        'required_entrance_exams_json',
        'program.degree_level',
        'program.instruction_language',
      ),
    ],
    wikiStatus: 'ACTIVE',
  };

  return [country, city, origin, university, housing, program];
}

// ---- WUT B.Sc. CS 2027 ----------------------------------------------------------------------------------

const WUT_SLOT_OWNERS: Readonly<Record<string, WikiLayer>> = {
  program_deadlines_and_app_fee: 'PROGRAM_SPEC',
  admission_documents_two_stage_irk: 'PROGRAM_SPEC',
  english_requirements_b2: 'PROGRAM_SPEC',
  origin_az_11yr_attestat_and_nawa_2025_law: 'ORIGIN_EQUIVALENCY',
  minor_under_18_consents: 'ORIGIN_EQUIVALENCY',
  tuition_non_eu_and_refund_policy: 'PROGRAM_SPEC',
  scholarships_bsc_non_eu: 'UNIVERSITY',
  city_profile_warsaw: 'CITY',
  university_housing_warsaw_dorms: 'HOUSING',
  irk_dynamic_portal_catalog: 'UNIVERSITY',
};

/** D-a: the fixture's NAWA-specific policy is the generic national-statement policy (§5.2 names NAWA SYRENA). */
const EQUIVALENCY_ALIASES: Readonly<Record<string, string>> = {
  DIRECT_WITH_NAWA_STATEMENT: 'DIRECT_WITH_NATIONAL_STATEMENT',
};

/** D-f: comparator program names -> program ids + field codes (ids for power/aerospace from ENG-T2 §4). */
const WUT_ALTERNATIVES: Readonly<Record<string, { readonly id: string; readonly fieldCode: string }>> = {
  'B.Sc. Power Engineering (7 sem)': { id: 'wut:bsc-power-eng', fieldCode: 'POWER_ENG' },
  'B.Sc. Aerospace Engineering (7 sem)': { id: 'wut:bsc-aerospace-eng', fieldCode: 'AEROSPACE_ENG' },
  'B.Sc. Environmental Engineering (7 sem)': {
    id: 'wut:bsc-environmental-eng',
    fieldCode: 'ENVIRONMENTAL_ENG',
  },
  'B.Sc. Mechatronics (7 sem)': { id: 'wut:bsc-mechatronics', fieldCode: 'MECHATRONICS' },
  'B.Sc. Electrical Engineering (7 sem)': { id: 'wut:bsc-electrical-eng', fieldCode: 'ELECTRICAL_ENG' },
  'B.Sc. CS & Information Systems — MiNI (7 sem)': {
    id: 'wut:bsc-cs-information-systems-mini',
    fieldCode: 'CS_IT',
  },
};

/** D-d: WUT's "middle of <month> 2027 (to be updated)" dates, as Europe/Warsaw (CEST) end-of-day instants. */
const WUT_WINDOW = {
  open: '2027-05-01T00:00:00+02:00',
  close: '2027-07-15T23:59:00+02:00',
  qualifiedDocs: '2027-08-15T23:59:00+02:00',
} as const;

function mapWut(f: FixtureNode, file: string): GoldenNode[] {
  const season = seasonOf(f.str('compiled_key'));
  const score = scoreOf(f);
  const l1 = f.at('layer_1_country');
  const l1b = f.at('layer_1b_city_profile');
  const l2 = f.at('layer_2_origin_equivalency');
  const l3 = f.at('layer_3_university');
  const l3b = f.at('layer_3b_university_housing');
  const l4 = f.at('layer_4_program_season_spec');
  const syrena = l2.at('nawa_syrena_procedure');
  const english = l4.at('english_requirements');
  const tests = english.at('accepted_tests');
  const timeline = l4.at('intake_timeline_2027_fall');
  const slots = (layer: WikiLayer) => slotsFor(f, WUT_SLOT_OWNERS, layer);
  // D-d sanity: the fixed instants must agree with the fixture's own dates
  if (!timeline.str('new_application_deadline').startsWith(WUT_WINDOW.close.slice(0, 10))) {
    throw new RangeError(`${file}: intake deadline no longer matches the D-d mapping`);
  }

  const country: GoldenNode = {
    layer: 'COUNTRY',
    nodeKey: `${l1.str('country_iso2')}:${season}`,
    fields: {
      country_iso2: l1.str('country_iso2'),
      admission_season: season,
      rules_payload_json: l1.objectWithout('citations'),
    },
    ...PRIMARY,
    score,
    citations: l1.citations(pathMapper('rules_payload_json')),
    slots: slots('COUNTRY'),
    uncitedBasis: [],
    wikiStatus: null,
  };

  const nfz = l1b.at('healthcare_nfz_warsaw');
  const cityId = l1b.str('city_id');
  const city: GoldenNode = {
    layer: 'CITY',
    nodeKey: cityId,
    fields: {
      id: cityId,
      country_iso2: l1b.str('country_iso2'),
      city_name_en: l1b.str('city_name_en'),
      monthly_living_min_eur: null, // D-g: Warsaw costs are PLN-only; no FX rate is invented
      monthly_living_max_eur: null,
      minor_consents_json: [
        {
          code: 'NFZ_PARENT_CONSENT',
          authority: 'NFZ (Polish National Health Fund)',
          description: nfz.str('minor_under_18_requirement'),
          form_url: null,
        },
      ],
      attributes_json: l1b.objectWithout('citations', 'city_id', 'city_name_en', 'country_iso2'),
    },
    ...PRIMARY,
    score,
    citations: l1b.citations(
      pathMapper('attributes_json', {
        'healthcare_nfz_warsaw.minor_under_18_requirement': 'minor_consents_json',
      }),
    ),
    slots: slots('CITY'),
    uncitedBasis: ruled('FIXTURE_VALUE_UNCITED', 'city_name_en'),
    wikiStatus: null,
  };

  const policy = l2.str('equivalency_policy');
  const minorUpload = syrena.strings('required_uploads').find((u) => /age < 18/i.test(u));
  if (minorUpload === undefined) throw new RangeError(`${file}: no <18 SYRENA upload rule`);
  const origin: GoldenNode = {
    layer: 'ORIGIN_EQUIVALENCY',
    nodeKey: [
      l2.str('destination_country_iso2'),
      l2.str('citizenship_country'),
      l2.str('diploma_origin_country'),
      l2.str('diploma_type'),
      season,
    ].join(':'),
    fields: {
      destination_country_iso2: l2.str('destination_country_iso2'),
      citizenship_country: l2.str('citizenship_country'),
      diploma_origin_country: l2.str('diploma_origin_country'),
      diploma_type: l2.str('diploma_type'),
      admission_season: season,
      equivalency_policy: EQUIVALENCY_ALIASES[policy] ?? policy, // D-a
      national_recognition_lead_days: syrena.num('processing_time_days_max'), // 60
      ru_sector_translation_exempt: syrena.bool('ru_sector_translation_exemption'),
      paper_apostille_accepted: true, // Hague apostille on the Attestat is required (column default)
      e_apostille_accepted: true, // column default; fixture silent
      minor_consents_json: [
        {
          code: 'NAWA_SYRENA_GUARDIAN_DECLARATION',
          authority: 'NAWA (SYRENA)',
          description: minorUpload,
          form_url: syrena.str('minor_declaration_form_url'),
        },
      ],
      legalization_rules_json: l2.objectWithout('citations'),
    },
    ...PRIMARY,
    score,
    citations: l2.citations(
      pathMapper('legalization_rules_json', {
        'nawa_syrena_procedure.ru_sector_translation_exemption': 'ru_sector_translation_exempt',
      }),
    ),
    slots: slots('ORIGIN_EQUIVALENCY'),
    uncitedBasis: [
      ...ruled('RULING_D_A', 'equivalency_policy'),
      ...ruled(
        'FIXTURE_VALUE_UNCITED',
        'national_recognition_lead_days',
        'paper_apostille_accepted',
        'e_apostille_accepted',
        'minor_consents_json',
      ),
    ],
    wikiStatus: null,
  };

  const uniId = l3.str('university_id');
  const isoConsent = l4
    .at('document_stages')
    .list('stage_4_on_arrival_originals_iso')
    .find((d) => d.str('code') === 'MINOR_PARENTAL_CONSENT_WUT');
  if (isoConsent === undefined) throw new RangeError(`${file}: no MINOR_PARENTAL_CONSENT_WUT document`);
  const university: GoldenNode = {
    layer: 'UNIVERSITY',
    nodeKey: uniId,
    fields: {
      id: uniId,
      name_en: l3.str('name_en'),
      name_local: l3.str('name_local'),
      country_iso2: l1.str('country_iso2'),
      city_id: l3.str('city_id'),
      institution_type: l3.str('institution_type'),
      official_domain: l3.str('official_domain'),
      // [DERIVED] domain of the official ISO contact address
      official_email_domains_json: [l3.str('iso_email').split('@')[1] ?? ''],
      primary_portal_type: 'IRK',
      portal_url: l3.str('irk_portal_url'),
      sends_email_notifications: true, // column default; fixture silent
      credit_card_accepted: l3.at('payment_rails_and_refund_policy').bool('credit_card_accepted'), // false
      pricing_tier_code: pricingTierFor(l1.str('country_iso2')), // B5: by destination country (ops-owned)
      // D-i: the WUT ISO parental consent is university-level (all WUT programmes)
      minor_consents_json: [
        {
          code: 'WUT_ISO_PARENTAL_CONSENT',
          authority: 'WUT International Students Office',
          description: isoConsent.str('rules'),
          form_url: null,
        },
      ],
      general_rules_json: l3.objectWithout('citations'),
    },
    ...PRIMARY,
    score,
    citations: l3.citations(
      pathMapper('general_rules_json', {
        'payment_rails_and_refund_policy.credit_card_accepted': 'credit_card_accepted',
        minor_consents: 'minor_consents_json',
      }),
    ),
    slots: slots('UNIVERSITY'),
    uncitedBasis: ruled('FIXTURE_VALUE_UNCITED', 'institution_type', 'primary_portal_type'),
    wikiStatus: null,
  };

  // [DERIVED] "2026-10-01 to 2027-06-30" -> academic-year rates season '2026-2027'
  const period = /^(\d{4})-\d{2}-\d{2} to (\d{4})-/.exec(l3b.str('rates_period'));
  if (period === null) throw new RangeError(`${file}: unparseable rates_period`);
  const ratesSeason = `${period[1]}-${period[2]}`;
  const housing: GoldenNode = {
    layer: 'HOUSING',
    nodeKey: `${uniId}:${ratesSeason}`,
    fields: {
      university_id: uniId,
      rates_season: ratesSeason,
      portal_url: l3b.str('polish_portal_url'),
      official_info_url: l3b.str('official_info_url'),
      rate_pdf_url: l3b.str('tariff_decree_pdf_url'),
      total_places: null,
      subsidized_places: null,
      monthly_min_eur: null, // D-g: PLN-only rates
      monthly_max_eur: null,
      non_refundable_on_visa_denial: false, // column default; fixture states no visa-denial forfeit rule
      critical_rules_json: l3b.objectWithout('citations', 'warsaw_halls_2026_2027_pln_monthly'),
      halls_json: l3b.list('warsaw_halls_2026_2027_pln_monthly').map((h) => h.objectWithout()),
    },
    ...PRIMARY,
    score,
    citations: l3b.citations(
      pathMapper('critical_rules_json', { warsaw_halls_2026_2027_pln_monthly: 'halls_json' }),
    ),
    slots: slots('HOUSING'),
    uncitedBasis: ruled('FIXTURE_VALUE_UNCITED', 'official_info_url', 'non_refundable_on_visa_denial'),
    wikiStatus: null,
  };

  const programId = l4.str('program_id');
  const tuition = l4.at('tuition_non_eu_eur');
  // University-wide B.Sc. rules shared by the primary programme and (D-f) its comparators.
  const shared = {
    admission_season: season,
    scholarship_waiver_codes_json: l4.strings('scholarship_waiver_codes'), // []
    accepted_prior_fields_json: l4.at('accepted_prior_fields').objectWithout(), // B3
    predicted_grades_accepted: l4.bool('predicted_grades_accepted'), // false
    min_gpa_100: null, // D-h: 70% is advisory only
    min_math_100: null,
    high_school_emi_accepted: english.bool('high_school_emi_letter_accepted'), // false
    min_bsc_emi_pct: null,
    min_english_requirements_json: {
      min_cefr: english.str('min_cefr'),
      accepted_tests: [
        {
          exam: 'IELTS_ACADEMIC',
          min_score: tests.at('IELTS_ACADEMIC').num('min_overall'),
          valid_from: null,
          valid_until: null,
        },
        // ENG-T2 §5.2: TOEFL iBT scale switch on 2026-01-21 (87 legacy / 4.5 new at WUT)
        {
          exam: 'TOEFL_IBT',
          min_score: tests.at('TOEFL_IBT_LEGACY').num('min_score'),
          valid_from: null,
          valid_until: '2026-01-20',
        },
        {
          exam: 'TOEFL_IBT',
          min_score: tests.at('TOEFL_IBT_2026_SCALE').num('min_score'),
          valid_from: '2026-01-21',
          valid_until: null,
        },
        {
          exam: 'PTE_ACADEMIC',
          min_score: tests.at('PTE_ACADEMIC').num('min_score'),
          valid_from: null,
          valid_until: null,
        },
      ],
      rejected_tests: english.bool('duolingo_accepted') ? [] : ['DUOLINGO'],
      other_accepted: [
        ...tests.strings('CAMBRIDGE'),
        ...tests.strings('LANGUAGECERT'),
        ...tests.strings('TRINITY'),
        ...tests.strings('TELC'),
        `TOEIC LR ${tests.at('TOEIC').num('min_lr')} / S ${tests.at('TOEIC').num('min_speaking')} / W ${tests.at('TOEIC').num('min_writing')}`,
      ],
    },
    // 4 April 2025 law: interview before the final acceptance letter -> pre-admission gate
    required_entrance_exams_json: [
      {
        code: 'ONLINE_ENTRANCE_INTERVIEW',
        kind: 'INTERVIEW',
        satisfied_by: [],
        mandatory: true,
        stage: 'PRE_ADMISSION',
      },
    ],
    schooling_11yr_override: null,
    app_window_open_at: WUT_WINDOW.open,
    app_window_close_at: WUT_WINDOW.close,
    qualified_docs_deadline_at: WUT_WINDOW.qualifiedDocs,
    classes_start_date: l4.str('classes_start_date'), // '2027-10-01'
    official_portal_fee_eur_cents: null, // D-g: the 85 PLN fee has no EUR amount
  };

  const primary: GoldenNode = {
    layer: 'PROGRAM_SPEC',
    nodeKey: `${programId}:${season}`,
    fields: {
      ...shared,
      program_id: programId,
      tuition_annual_eur: tuition.num('per_year_eur'), // 11040
      program_requirements_json: l4.objectWithout(
        'citations',
        'accepted_prior_fields',
        'predicted_grades_accepted',
        'scholarship_waiver_codes',
      ),
      program: {
        id: programId,
        university_id: uniId,
        name_en: l4.str('name_en'),
        name_local: null,
        degree_level: l4.str('degree_level'),
        field_code: 'CS_IT', // D-n
        instruction_language: l4.str('instruction_language'),
        duration_semesters: l4.num('duration_semesters'),
        ects_total: null,
        official_program_url: tuition.str('source_url'), // D-n: the official B.Sc. offer page
      },
    },
    ...PRIMARY,
    score,
    citations: l4.citations(
      pathMapper('program_requirements_json', {
        english_requirements: 'min_english_requirements_json',
        predicted_grades_accepted: 'predicted_grades_accepted',
        tuition_non_eu_eur: 'tuition_annual_eur',
        intake_timeline_2027_fall: 'app_window_close_at',
      }),
    ),
    slots: slots('PROGRAM_SPEC'),
    uncitedBasis: [
      ...ruled('SPEC_G7', 'scholarship_waiver_codes_json'),
      ...ruled('RULING_B3', 'accepted_prior_fields_json'),
      ...ruled(
        'FIXTURE_VALUE_UNCITED',
        'required_entrance_exams_json',
        'program.degree_level',
        'program.instruction_language',
      ),
    ],
    wikiStatus: 'ACTIVE',
  };

  // D-f: the 6 comparators import as BASELINE + ACTIVE (NULL score, no DEEP_VERIFIED claim)
  const alternatives = l4.list('same_uni_lower_tuition_alternatives_2026_2027').map((alt): GoldenNode => {
    const label = alt.str('program');
    const ids = WUT_ALTERNATIVES[label];
    if (ids === undefined) throw new RangeError(`${file}: unmapped comparator programme '${label}'`);
    const semesters = /\((\d+) sem\)/.exec(label);
    if (semesters === null) throw new RangeError(`${file}: no semester count in '${label}'`);
    if (alt.str('import_verification_depth') !== 'BASELINE')
      throw new RangeError(`${file}: ${label} is not marked BASELINE`);
    return {
      layer: 'PROGRAM_SPEC',
      nodeKey: `${ids.id}:${season}`,
      fields: {
        ...shared,
        program_id: ids.id,
        tuition_annual_eur: alt.num('annual_eur'),
        program_requirements_json: {
          inherited_from: programId,
          non_eu_per_sem_eur: alt.num('non_eu_per_sem_eur'),
          academic_year_basis: tuition.str('academic_year_basis'),
        },
        program: {
          id: ids.id,
          university_id: uniId,
          name_en: label.replace(/^B\.Sc\.\s*/, '').replace(/\s*\(\d+ sem\)$/, ''),
          name_local: null,
          degree_level: 'BACHELOR',
          field_code: ids.fieldCode,
          instruction_language: l4.str('instruction_language'), // inherited (D-f)
          duration_semesters: Number(semesters[1]),
          ects_total: null,
          official_program_url: alt.str('source_url'),
        },
      },
      depth: 'BASELINE',
      score: null,
      citations: [],
      slots: {},
      // D-f: no quotes exist for the comparators; every required value is ruled
      uncitedBasis: ruled('RULING_D_F', ...LAYERS.PROGRAM_SPEC.requiredPaths),
      wikiStatus: 'ACTIVE',
    };
  });

  return [country, city, origin, university, housing, primary, ...alternatives];
}

// ---- dispatch -------------------------------------------------------------------------------------------

const MAPPERS: Readonly<
  Record<string, (f: FixtureNode, file: string, ledger: RulingLedger) => GoldenNode[]>
> = {
  '2027-FALL:polimi:msc-cse:AZ:AZ:BACHELOR_DEGREE': mapPolimi,
  '2027-FALL:wut:bsc-cs-networks:AZ:AZ:CIS_11YR_ATTESTAT': mapWut,
};

export function planGoldenImport(file: string, fixture: FixtureNode): GoldenPlan {
  const compiledKey = fixture.str('compiled_key');
  const mapper = MAPPERS[compiledKey];
  if (mapper === undefined)
    throw new RangeError(`${file}: no golden mapping for compiled_key ${compiledKey}`);
  const ledger = new RulingLedger();
  const nodes = mapper(fixture, file, ledger);
  return { file, compiledKey, season: seasonOf(compiledKey), nodes, pending: ledger.pending };
}
