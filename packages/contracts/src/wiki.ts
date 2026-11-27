import { z } from 'zod';
import { DestinationCountry } from './wiki-enums.js';

/**
 * wiki-v2.0 contracts (ENG-T2 §1-§4). Field names of the layer schemas are the exact `wiki.*` column names,
 * so a citation `field_path` / `locked_fields_json` entry addresses a column (or a dotted path inside a
 * jsonb column) with zero translation between proposal, validator, database and lock pins.
 */

export const WikiLayer = z.enum([
  'COUNTRY',
  'CITY',
  'ORIGIN_EQUIVALENCY',
  'UNIVERSITY',
  'HOUSING',
  'PROGRAM_SPEC',
]);
export type WikiLayer = z.infer<typeof WikiLayer>;

export const VerificationDepth = z.enum(['BASELINE', 'DEEP_VERIFIED', 'QUARANTINED']);
export type VerificationDepth = z.infer<typeof VerificationDepth>;

export const WikiStatus = z.enum(['DRAFT', 'ACTIVE', 'CLOSED', 'ARCHIVED']);
export type WikiStatus = z.infer<typeof WikiStatus>;

export const RevisionActor = z.enum(['AI_CURATOR', 'GOLDEN_FIXTURE', 'HUMAN']);
export type RevisionActor = z.infer<typeof RevisionActor>;

export const EquivalencyPolicy = z.enum([
  'DIRECT',
  'DIRECT_WITH_NATIONAL_STATEMENT',
  'FOUNDATION_REQUIRED',
  'ONE_YEAR_UNI_REQUIRED',
  'NOT_ELIGIBLE',
]);
export type EquivalencyPolicy = z.infer<typeof EquivalencyPolicy>;

export const DiplomaType = z.enum([
  'CIS_11YR_ATTESTAT',
  'BACHELOR_DEGREE',
  'UNI_1YR_COMPLETED',
  'IB',
  'A_LEVEL',
]);
export type DiplomaType = z.infer<typeof DiplomaType>;

export const DegreeLevel = z.enum(['BACHELOR', 'MASTER']);
export type DegreeLevel = z.infer<typeof DegreeLevel>;

export const PortalType = z.enum([
  'UNI_ASSIST',
  'UNIVERSITALY',
  'DREAMAPPLY',
  'STIPENDIUM_HUNGARICUM',
  'TURKISH_OBS',
  'IRK',
  'DIRECT',
]);
export type PortalType = z.infer<typeof PortalType>;

export const ExamType = z.enum([
  'IELTS_ACADEMIC',
  'IELTS_GENERAL',
  'TOEFL_IBT',
  'PTE_ACADEMIC',
  'CAMBRIDGE_FCE',
  'CAMBRIDGE_CAE',
  'DUOLINGO',
  'SAT',
  'TOLC_I',
  'TR_YOS',
  'GRE',
]);
export type ExamType = z.infer<typeof ExamType>;

/** `YYYY-FALL` / `YYYY-SPRING` admission season key. */
export const AdmissionSeason = z
  .string()
  .regex(/^\d{4}-(FALL|SPRING)$/, { message: "must be 'YYYY-FALL|SPRING'" });
export const Iso2 = z.string().regex(/^[A-Z]{2}$/, { message: 'must be ISO 3166-1 alpha-2' });
/** ISO-2 country, or `'**'` for universal diplomas (IB / A_LEVEL) on origin rules (ENG-T2 §5.2). */
export const OriginCountry = z.string().regex(/^([A-Z]{2}|\*\*)$/);
export const IsoDate = z.iso.date();
export const IsoDateTime = z.iso.datetime({ offset: true });

/** A citation as stored in `citations_json` (golden fixtures carry no snapshot id). */
export const Citation = z.strictObject({
  field_path: z.string().min(1),
  snapshot_id: z.uuid().nullable(),
  source_url: z.url({ protocol: /^https?$/ }),
  verbatim_quote: z.string().min(1),
  retrieved_at: IsoDateTime,
});
export type Citation = z.infer<typeof Citation>;

/** A citation proposed by Agent A: it MUST point at a stored source snapshot (validated deterministically). */
export const ProposalCitation = Citation.extend({ snapshot_id: z.uuid() });
export type ProposalCitation = z.infer<typeof ProposalCitation>;

export const SlotStatus = z.enum([
  'VERIFIED_CURRENT',
  'BASELINE_PREV_SEASON',
  'NEEDS_HUMAN_OR_PDF_FETCH',
  'JS_GATE_CONFIRMED',
  'MISSING_SOURCE_404',
  /** FETCH_TIMEOUT / NETWORK_ERROR (http_status = 0): retry, not a permanent gap (ENG-T2 §0 Q2). */
  'TRANSIENT_FETCH_FAILURE',
]);
export type SlotStatus = z.infer<typeof SlotStatus>;

export const SlotEntry = z.strictObject({
  status: SlotStatus,
  season: z.string().optional(),
  expected_refresh_month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  note: z.string().optional(),
});
export type SlotEntry = z.infer<typeof SlotEntry>;

export const SlotCompleteness = z.record(z.string().min(1), SlotEntry);
export type SlotCompleteness = z.infer<typeof SlotCompleteness>;

/** One `<18` consent obligation (aggregated by the matcher into MINOR_UNDER_18_CONSENTS). */
export const MinorConsent = z.strictObject({
  code: z.string().regex(/^[A-Z0-9_]+$/),
  authority: z.string().min(1),
  description: z.string().min(1),
  form_url: z.url().nullable(),
});
export type MinorConsent = z.infer<typeof MinorConsent>;

const JsonObject = z.record(z.string(), z.unknown());

// ---- Layer field schemas (exact column names; jsonb columns typed where the matcher reads them) ----

export const CountryRuleFields = z.strictObject({
  country_iso2: DestinationCountry,
  admission_season: AdmissionSeason,
  rules_payload_json: JsonObject,
});
export type CountryRuleFields = z.infer<typeof CountryRuleFields>;

export const CityProfileFields = z.strictObject({
  id: z.string().regex(/^[A-Z]{2}-[A-Z0-9-]+$/),
  country_iso2: DestinationCountry,
  city_name_en: z.string().min(1),
  monthly_living_min_eur: z.int().min(0).nullable(),
  monthly_living_max_eur: z.int().min(0).nullable(),
  minor_consents_json: z.array(MinorConsent),
  attributes_json: JsonObject,
});
export type CityProfileFields = z.infer<typeof CityProfileFields>;

export const OriginEquivalencyFields = z.strictObject({
  destination_country_iso2: DestinationCountry,
  citizenship_country: OriginCountry,
  diploma_origin_country: OriginCountry,
  diploma_type: DiplomaType,
  admission_season: AdmissionSeason,
  equivalency_policy: EquivalencyPolicy,
  national_recognition_lead_days: z.int().min(0).max(32767),
  ru_sector_translation_exempt: z.boolean(),
  paper_apostille_accepted: z.boolean(),
  e_apostille_accepted: z.boolean(),
  minor_consents_json: z.array(MinorConsent),
  legalization_rules_json: JsonObject,
});
export type OriginEquivalencyFields = z.infer<typeof OriginEquivalencyFields>;

export const UniversityFields = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name_en: z.string().min(1),
  name_local: z.string().min(1).nullable(),
  country_iso2: DestinationCountry,
  city_id: z.string().min(1),
  institution_type: z.enum(['PUBLIC', 'PRIVATE']),
  official_domain: z.string().regex(/^[a-z0-9.-]+$/),
  official_email_domains_json: z.array(z.string().regex(/^[a-z0-9.-]+$/)),
  primary_portal_type: PortalType,
  portal_url: z.url().nullable(),
  sends_email_notifications: z.boolean(),
  credit_card_accepted: z.boolean(),
  pricing_tier_code: z.enum(['T1', 'T2', 'T3']),
  minor_consents_json: z.array(MinorConsent),
  general_rules_json: JsonObject,
});
export type UniversityFields = z.infer<typeof UniversityFields>;

export const HousingFields = z.strictObject({
  university_id: z.string().min(1),
  rates_season: z.string().regex(/^\d{4}-\d{4}$/),
  portal_url: z.url().nullable(),
  official_info_url: z.url(),
  rate_pdf_url: z.url().nullable(),
  total_places: z.int().min(0).nullable(),
  subsidized_places: z.int().min(0).nullable(),
  monthly_min_eur: z.int().min(0).nullable(),
  monthly_max_eur: z.int().min(0).nullable(),
  non_refundable_on_visa_denial: z.boolean(),
  critical_rules_json: JsonObject,
  halls_json: z.array(JsonObject),
});
export type HousingFields = z.infer<typeof HousingFields>;

export const ProgramFields = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+:[a-z0-9-]+$/),
  university_id: z.string().min(1),
  name_en: z.string().min(1),
  name_local: z.string().min(1).nullable(),
  degree_level: DegreeLevel,
  field_code: z
    .string()
    .regex(/^[A-Z0-9_]+$/)
    .max(64),
  instruction_language: z.string().regex(/^[a-z]{2}$/),
  duration_semesters: z.int().min(1).max(12),
  ects_total: z.int().min(1).max(32767).nullable(),
  official_program_url: z.url(),
});
export type ProgramFields = z.infer<typeof ProgramFields>;

export const AcceptedPriorFields = z.strictObject({
  exact: z.array(z.string().min(1)),
  adjacent: z.array(z.string().min(1)),
});
export type AcceptedPriorFields = z.infer<typeof AcceptedPriorFields>;

/** One accepted English test with its (optional) dated validity window, e.g. TOEFL 78 until 2026-01-20. */
export const EnglishTestRequirement = z.strictObject({
  exam: ExamType,
  min_score: z.number().min(0),
  valid_from: IsoDate.nullable(),
  valid_until: IsoDate.nullable(),
});
export type EnglishTestRequirement = z.infer<typeof EnglishTestRequirement>;

export const EnglishRequirements = z.strictObject({
  min_cefr: z.enum(['B1', 'B2', 'C1']).nullable(),
  accepted_tests: z.array(EnglishTestRequirement),
  rejected_tests: z.array(ExamType),
  /** Free-form accepted certificates the deterministic matcher does not score (Cambridge grades, TOEIC...). */
  other_accepted: z.array(z.string()),
});
export type EnglishRequirements = z.infer<typeof EnglishRequirements>;

export const EntranceRequirement = z.strictObject({
  code: z.string().regex(/^[A-Z0-9_]+$/),
  kind: z.enum(['EXAM', 'INTERVIEW']),
  /** Exam types that satisfy it when OBTAINED (empty: never satisfiable before the university runs it). */
  satisfied_by: z.array(ExamType),
  mandatory: z.boolean(),
  /** PRE_ADMISSION gates the admission/acceptance letter, so an unmet one makes the match CONDITIONAL. */
  stage: z.enum(['PRE_ADMISSION', 'POST_ADMISSION']),
});
export type EntranceRequirement = z.infer<typeof EntranceRequirement>;

export const ProgramSeasonSpecFields = z.strictObject({
  program_id: z.string().min(1),
  admission_season: AdmissionSeason,
  tuition_annual_eur: z.int().min(0),
  scholarship_waiver_codes_json: z.array(z.string().regex(/^[A-Z0-9_]+$/)),
  accepted_prior_fields_json: AcceptedPriorFields,
  predicted_grades_accepted: z.boolean(),
  min_gpa_100: z.number().min(0).max(100).nullable(),
  min_math_100: z.number().min(0).max(100).nullable(),
  high_school_emi_accepted: z.boolean(),
  min_bsc_emi_pct: z.int().min(1).max(100).nullable(),
  min_english_requirements_json: EnglishRequirements,
  required_entrance_exams_json: z.array(EntranceRequirement),
  schooling_11yr_override: EquivalencyPolicy.nullable(),
  app_window_open_at: IsoDateTime.nullable(),
  app_window_close_at: IsoDateTime,
  qualified_docs_deadline_at: IsoDateTime.nullable(),
  classes_start_date: IsoDate.nullable(),
  official_portal_fee_eur_cents: z.int().min(0).nullable(),
  program_requirements_json: JsonObject,
});
export type ProgramSeasonSpecFields = z.infer<typeof ProgramSeasonSpecFields>;

/** PROGRAM_SPEC node = the season spec columns + the (static) program row it belongs to. */
export const ProgramSpecNodeFields = ProgramSeasonSpecFields.extend({ program: ProgramFields });
export type ProgramSpecNodeFields = z.infer<typeof ProgramSpecNodeFields>;

export const LAYER_FIELD_SCHEMAS = {
  COUNTRY: CountryRuleFields,
  CITY: CityProfileFields,
  ORIGIN_EQUIVALENCY: OriginEquivalencyFields,
  UNIVERSITY: UniversityFields,
  HOUSING: HousingFields,
  PROGRAM_SPEC: ProgramSpecNodeFields,
} as const satisfies Record<WikiLayer, z.ZodType>;

export interface LayerFieldsMap {
  COUNTRY: CountryRuleFields;
  CITY: CityProfileFields;
  ORIGIN_EQUIVALENCY: OriginEquivalencyFields;
  UNIVERSITY: UniversityFields;
  HOUSING: HousingFields;
  PROGRAM_SPEC: ProgramSpecNodeFields;
}

// ---- Slice Cards (ENG-T2 §4 step 5.2) ----

export const SliceCardKind = z.enum(['docs', 'tuition_aid', 'city', 'dorms']);
export type SliceCardKind = z.infer<typeof SliceCardKind>;

/** Hard invariant: `Math.ceil(text.length / 4) <= 350` tokens (<= 1,400 characters). */
export const SLICE_CARD_MAX_TOKENS = 350;
export const SLICE_CARD_MAX_CHARS = SLICE_CARD_MAX_TOKENS * 4;

export const SliceCard = z.strictObject({
  kind: SliceCardKind,
  node_id: z.string().min(1),
  season: AdmissionSeason,
  text: z.string().min(1).max(SLICE_CARD_MAX_CHARS),
  est_tokens: z.int().min(1).max(SLICE_CARD_MAX_TOKENS),
  source_domains: z.array(z.string().min(1)).min(1),
  verification_depth: VerificationDepth,
  version: z.int().min(1),
});
export type SliceCard = z.infer<typeof SliceCard>;
