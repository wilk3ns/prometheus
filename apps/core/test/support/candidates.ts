import type { ApplicantMatchInput } from '@prometheus/contracts';
import type { OriginRuleView, ProgramCandidate } from '../../src/modules/matching/index.js';

/** Synthetic catalog builders for the pure L1 engine tests (shapes mirror the wiki-v2.0 read model). */

type SpecOverrides = Partial<ProgramCandidate['spec']>;

export function candidate(
  id: string,
  overrides: {
    spec?: SpecOverrides;
    program?: Partial<ProgramCandidate['program']>;
    candidate?: Partial<ProgramCandidate>;
  } = {},
): ProgramCandidate {
  return {
    specId: '0193f2a0-0000-7000-8000-00000000c0de',
    depth: 'DEEP_VERIFIED',
    wikiStatus: 'ACTIVE',
    program: {
      id,
      university_id: id.split(':')[0] ?? 'uni',
      name_en: 'Computer Science',
      name_local: null,
      degree_level: 'BACHELOR',
      field_code: 'CS_IT',
      instruction_language: 'en',
      duration_semesters: 8,
      ects_total: null,
      official_program_url: 'https://www.pw.edu.pl/x',
      ...overrides.program,
    },
    spec: {
      program_id: id,
      admission_season: '2027-FALL',
      tuition_annual_eur: 4000,
      scholarship_waiver_codes_json: [],
      accepted_prior_fields_json: { exact: ['STEM_QRUP_1'], adjacent: ['ECON_QRUP_2'] },
      predicted_grades_accepted: false,
      min_gpa_100: null,
      min_math_100: null,
      high_school_emi_accepted: false,
      min_bsc_emi_pct: null,
      min_english_requirements_json: {
        min_cefr: 'B2',
        accepted_tests: [
          { exam: 'IELTS_ACADEMIC', min_score: 6, valid_from: null, valid_until: null },
          { exam: 'TOEFL_IBT', min_score: 87, valid_from: null, valid_until: '2026-01-20' },
          { exam: 'TOEFL_IBT', min_score: 4.5, valid_from: '2026-01-21', valid_until: null },
        ],
        rejected_tests: ['DUOLINGO'],
        other_accepted: [],
      },
      required_entrance_exams_json: [],
      schooling_11yr_override: null,
      app_window_open_at: '2027-05-01T00:00:00.000Z',
      app_window_close_at: '2027-07-15T21:59:00.000Z',
      qualified_docs_deadline_at: '2027-08-15T21:59:00.000Z',
      classes_start_date: '2027-10-01',
      official_portal_fee_eur_cents: null,
      ...overrides.spec,
    },
    university: {
      id: id.split(':')[0] ?? 'uni',
      countryIso2: 'PL',
      creditCardAccepted: true,
      minorConsents: [],
    },
    city: { monthlyLivingMinEur: null, minorConsents: [] },
    housing: { monthlyMinEur: null },
    ...overrides.candidate,
  };
}

export function origin(overrides: Partial<OriginRuleView> = {}): OriginRuleView {
  return {
    destinationCountryIso2: 'PL',
    citizenshipCountry: 'AZ',
    diplomaOriginCountry: 'AZ',
    diplomaType: 'CIS_11YR_ATTESTAT',
    admissionSeason: '2027-FALL',
    equivalencyPolicy: 'DIRECT',
    nationalRecognitionLeadDays: 0,
    ruSectorTranslationExempt: false,
    minorConsents: [],
    depth: 'DEEP_VERIFIED',
    ...overrides,
  };
}

export function applicant(overrides: Partial<ApplicantMatchInput> = {}): ApplicantMatchInput {
  return {
    dob: '2005-01-01',
    citizenshipCountry: 'AZ',
    residenceCountry: 'AZ',
    diplomaCountry: 'AZ',
    diplomaType: 'CIS_11YR_ATTESTAT',
    yearsOfSchooling: 11,
    diplomaStatus: 'ISSUED',
    priorInstructionLanguage: 'az',
    priorEmiPct: 0,
    priorFieldCode: 'STEM_QRUP_1',
    gpaNormalized100: 85,
    targetDegree: 'BACHELOR',
    targetSeason: '2027-FALL',
    targetFields: [],
    preferredCountries: [],
    instructionLanguages: ['en'],
    annualBudgetEur: 10_000,
    openToScholarships: false,
    householdIncomeUnder25kEur: 'UNKNOWN',
    exams: [{ type: 'IELTS_ACADEMIC', status: 'OBTAINED', score: 6.5 }],
    ...overrides,
  };
}

export const NOW = new Date('2027-05-10T12:00:00Z');
