import {
  CityProfileFields,
  CountryRuleFields,
  HousingFields,
  OriginEquivalencyFields,
  ProgramSpecNodeFields,
  UniversityFields,
  type LayerFieldsMap,
  type LayerHint,
  type SliceCardKind,
  type WikiLayer,
} from '@prometheus/contracts';
import type { z } from 'zod';

/** Builds a `nodeKeyOf` from a loose pick of the identifying columns. */
function keyed<T>(schema: z.ZodType<T>, format: (k: T) => string) {
  return (fields: Readonly<Record<string, unknown>>): string | undefined => {
    const parsed = schema.safeParse(fields);
    return parsed.success ? format(parsed.data) : undefined;
  };
}

/**
 * Layer descriptors: the single place that says, per wiki-v2.0 layer, how a node is keyed, which field paths
 * a verifier must check (and Agent A may not abstain on), which columns are ops-owned (never proposed by a
 * model) and which Slice Card the layer feeds.
 */
export interface LayerDescriptor<L extends WikiLayer> {
  readonly layer: L;
  /** Full field schema as stored. */
  readonly fields: z.ZodType<LayerFieldsMap[L]>;
  /** Schema a model proposes against (ops-owned columns removed). */
  readonly proposal: z.ZodType<Record<string, unknown>>;
  /**
   * Node key from the identifying fields only, so it works on proposals (which lack ops-owned columns) and
   * on full rows alike; `undefined` when the identifying fields are missing or invalid.
   */
  readonly nodeKeyOf: (fields: Readonly<Record<string, unknown>>) => string | undefined;
  readonly requiredPaths: readonly string[];
  /** Columns owned by operations, kept from the existing row on every AI commit. */
  readonly opsOwnedPaths: readonly string[];
  readonly card: SliceCardKind | undefined;
  /**
   * Canonical stored form (timestamptz columns as UTC ISO strings), so a node read back from Postgres equals
   * the node that was written and re-imports are detected as unchanged.
   */
  readonly normalize: (fields: LayerFieldsMap[L]) => LayerFieldsMap[L];
}

const identity = <T>(fields: T): T => fields;
const utc = (iso: string): string => new Date(iso).toISOString();

const country: LayerDescriptor<'COUNTRY'> = {
  layer: 'COUNTRY',
  fields: CountryRuleFields,
  proposal: CountryRuleFields,
  nodeKeyOf: keyed(
    CountryRuleFields.pick({ country_iso2: true, admission_season: true }).loose(),
    (k) => `${k.country_iso2}:${k.admission_season}`,
  ),
  requiredPaths: ['rules_payload_json'],
  opsOwnedPaths: [],
  card: undefined,
  normalize: identity,
};

const city: LayerDescriptor<'CITY'> = {
  layer: 'CITY',
  fields: CityProfileFields,
  proposal: CityProfileFields,
  nodeKeyOf: keyed(CityProfileFields.pick({ id: true }).loose(), (k) => k.id),
  requiredPaths: ['city_name_en', 'minor_consents_json', 'attributes_json'],
  opsOwnedPaths: [],
  card: 'city',
  normalize: identity,
};

const origin: LayerDescriptor<'ORIGIN_EQUIVALENCY'> = {
  layer: 'ORIGIN_EQUIVALENCY',
  fields: OriginEquivalencyFields,
  proposal: OriginEquivalencyFields,
  nodeKeyOf: keyed(
    OriginEquivalencyFields.pick({
      destination_country_iso2: true,
      citizenship_country: true,
      diploma_origin_country: true,
      diploma_type: true,
      admission_season: true,
    }).loose(),
    (k) =>
      [
        k.destination_country_iso2,
        k.citizenship_country,
        k.diploma_origin_country,
        k.diploma_type,
        k.admission_season,
      ].join(':'),
  ),
  requiredPaths: [
    'equivalency_policy',
    'national_recognition_lead_days',
    'ru_sector_translation_exempt',
    'paper_apostille_accepted',
    'e_apostille_accepted',
    'minor_consents_json',
  ],
  opsOwnedPaths: [],
  card: undefined,
  normalize: identity,
};

const university: LayerDescriptor<'UNIVERSITY'> = {
  layer: 'UNIVERSITY',
  fields: UniversityFields,
  // The Prometheus pricing tier is a commercial decision, not an official-source fact.
  proposal: UniversityFields.omit({ pricing_tier_code: true }),
  nodeKeyOf: keyed(UniversityFields.pick({ id: true }).loose(), (k) => k.id),
  requiredPaths: ['institution_type', 'primary_portal_type', 'credit_card_accepted', 'minor_consents_json'],
  opsOwnedPaths: ['pricing_tier_code'],
  card: 'tuition_aid',
  normalize: identity,
};

const housing: LayerDescriptor<'HOUSING'> = {
  layer: 'HOUSING',
  fields: HousingFields,
  proposal: HousingFields,
  nodeKeyOf: keyed(
    HousingFields.pick({ university_id: true, rates_season: true }).loose(),
    (k) => `${k.university_id}:${k.rates_season}`,
  ),
  requiredPaths: ['official_info_url', 'non_refundable_on_visa_denial', 'critical_rules_json'],
  opsOwnedPaths: [],
  card: 'dorms',
  normalize: identity,
};

const programSpec: LayerDescriptor<'PROGRAM_SPEC'> = {
  layer: 'PROGRAM_SPEC',
  fields: ProgramSpecNodeFields,
  proposal: ProgramSpecNodeFields,
  nodeKeyOf: keyed(
    ProgramSpecNodeFields.pick({ program_id: true, admission_season: true, program: true }).loose(),
    // the embedded program row must belong to the same program
    (k) =>
      k.program.id === k.program_id
        ? `${k.program_id}:${k.admission_season}`
        : `<program mismatch ${k.program.id}>`,
  ),
  requiredPaths: [
    'tuition_annual_eur',
    'scholarship_waiver_codes_json',
    'accepted_prior_fields_json',
    'predicted_grades_accepted',
    'min_english_requirements_json',
    'required_entrance_exams_json',
    'app_window_close_at',
    'program.degree_level',
    'program.instruction_language',
  ],
  opsOwnedPaths: [],
  card: 'docs',
  normalize: (f) => ({
    ...f,
    app_window_open_at: f.app_window_open_at === null ? null : utc(f.app_window_open_at),
    app_window_close_at: utc(f.app_window_close_at),
    qualified_docs_deadline_at:
      f.qualified_docs_deadline_at === null ? null : utc(f.qualified_docs_deadline_at),
  }),
};

export const LAYERS: { readonly [L in WikiLayer]: LayerDescriptor<L> } = {
  COUNTRY: country,
  CITY: city,
  ORIGIN_EQUIVALENCY: origin,
  UNIVERSITY: university,
  HOUSING: housing,
  PROGRAM_SPEC: programSpec,
};

/** Crawl target `layer_hint` -> wiki layer of the node it feeds. */
export function layerForHint(hint: LayerHint): WikiLayer {
  return hint === 'PROGRAM' ? 'PROGRAM_SPEC' : hint;
}

/** Parses raw fields against the layer schema and returns the canonical stored form. */
export function parseFields<L extends WikiLayer>(layer: L, raw: unknown): LayerFieldsMap[L] {
  const d: LayerDescriptor<L> = LAYERS[layer];
  return d.normalize(d.fields.parse(raw));
}

export function safeParseFields<L extends WikiLayer>(layer: L, raw: unknown): LayerFieldsMap[L] | undefined {
  const d: LayerDescriptor<L> = LAYERS[layer];
  const parsed = d.fields.safeParse(raw);
  return parsed.success ? d.normalize(parsed.data) : undefined;
}
