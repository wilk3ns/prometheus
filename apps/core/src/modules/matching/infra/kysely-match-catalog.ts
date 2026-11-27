import {
  EquivalencyPolicy,
  MinorConsent,
  ProgramFields,
  ProgramSeasonSpecFields,
  VerificationDepth,
  WikiStatus,
} from '@prometheus/contracts';
import type { Database } from '@prometheus/db';
import { sql } from 'kysely';
import { z } from 'zod';
import type { MatchCatalog, OriginRuleView, ProgramCandidate } from '../domain/catalog.js';
import type {
  MatchCatalogPort,
  ProgramListing,
  ProgramListingPort,
  SimilarityPort,
  SimilarityScore,
} from '../app/ports.js';

/**
 * Read-only matching adapters over the `app_core` connection (SELECT-only on `wiki.*` via `wiki_reader`).
 * The SQL pre-filter mirrors the L1 matchable rule (ACTIVE + BASELINE|DEEP_VERIFIED, non-quarantined
 * university); the pure engine re-checks it, so a wrong query can never widen the result.
 */

const Consents = z.array(MinorConsent);
const SpecColumns = ProgramSeasonSpecFields.omit({ program_requirements_json: true });

function iso(d: Date | null): string | null {
  return d === null ? null : d.toISOString();
}

export class KyselyMatchCatalog implements MatchCatalogPort, ProgramListingPort {
  constructor(private readonly db: Database) {}

  async listMatchable(season: string, country: string | undefined): Promise<ProgramListing[]> {
    let q = this.db
      .selectFrom('wiki.program_season_spec as s')
      .innerJoin('wiki.program as p', 'p.id', 's.program_id')
      .innerJoin('wiki.university as u', 'u.id', 'p.university_id')
      .select([
        'p.id',
        'p.name_en',
        'p.degree_level',
        'u.country_iso2',
        's.tuition_annual_eur',
        's.verification_depth',
      ])
      .where('s.admission_season', '=', season)
      .where('s.wiki_status', '=', 'ACTIVE')
      .where('s.verification_depth', 'in', ['BASELINE', 'DEEP_VERIFIED'])
      .orderBy('p.id');
    if (country !== undefined) q = q.where('u.country_iso2', '=', country);
    return q.execute();
  }

  async load(season: string, countries: readonly string[]): Promise<MatchCatalog> {
    let query = this.db
      .selectFrom('wiki.program_season_spec as s')
      .innerJoin('wiki.program as p', 'p.id', 's.program_id')
      .innerJoin('wiki.university as u', 'u.id', 'p.university_id')
      .leftJoin('wiki.city_profile as c', (j) =>
        j.onRef('c.id', '=', 'u.city_id').on('c.verification_depth', '<>', 'QUARANTINED'),
      )
      .select([
        's.id as spec_id',
        's.verification_depth',
        's.wiki_status',
        's.program_id',
        's.admission_season',
        's.tuition_annual_eur',
        's.scholarship_waiver_codes_json',
        's.accepted_prior_fields_json',
        's.predicted_grades_accepted',
        's.min_gpa_100',
        's.min_math_100',
        's.high_school_emi_accepted',
        's.min_bsc_emi_pct',
        's.min_english_requirements_json',
        's.required_entrance_exams_json',
        's.schooling_11yr_override',
        's.app_window_open_at',
        's.app_window_close_at',
        's.qualified_docs_deadline_at',
        's.classes_start_date',
        's.official_portal_fee_eur_cents',
        'p.university_id',
        'p.name_en',
        'p.name_local',
        'p.degree_level',
        'p.field_code',
        'p.instruction_language',
        'p.duration_semesters',
        'p.ects_total',
        'p.official_program_url',
        'u.country_iso2 as uni_country',
        'u.credit_card_accepted',
        'u.minor_consents_json as uni_consents',
        'c.monthly_living_min_eur',
        'c.minor_consents_json as city_consents',
        sql<number | null>`(SELECT min(h.monthly_min_eur) FROM wiki.university_housing h
          WHERE h.university_id = u.id AND h.verification_depth <> 'QUARANTINED')`.as('housing_min_eur'),
      ])
      .where('s.admission_season', '=', season)
      .where('s.wiki_status', '=', 'ACTIVE')
      .where('s.verification_depth', 'in', ['BASELINE', 'DEEP_VERIFIED'])
      .where('u.verification_depth', '<>', 'QUARANTINED')
      .orderBy('s.program_id');
    if (countries.length > 0) query = query.where('u.country_iso2', 'in', [...countries]);
    const rows = await query.execute();

    const candidates = rows.map((r): ProgramCandidate => ({
      specId: r.spec_id,
      depth: VerificationDepth.parse(r.verification_depth),
      wikiStatus: WikiStatus.parse(r.wiki_status),
      program: ProgramFields.parse({
        id: r.program_id,
        university_id: r.university_id,
        name_en: r.name_en,
        name_local: r.name_local,
        degree_level: r.degree_level,
        field_code: r.field_code,
        instruction_language: r.instruction_language,
        duration_semesters: r.duration_semesters,
        ects_total: r.ects_total,
        official_program_url: r.official_program_url,
      }),
      spec: SpecColumns.parse({
        program_id: r.program_id,
        admission_season: r.admission_season,
        tuition_annual_eur: r.tuition_annual_eur,
        scholarship_waiver_codes_json: r.scholarship_waiver_codes_json,
        accepted_prior_fields_json: r.accepted_prior_fields_json,
        predicted_grades_accepted: r.predicted_grades_accepted,
        min_gpa_100: r.min_gpa_100 === null ? null : Number(r.min_gpa_100),
        min_math_100: r.min_math_100 === null ? null : Number(r.min_math_100),
        high_school_emi_accepted: r.high_school_emi_accepted,
        min_bsc_emi_pct: r.min_bsc_emi_pct,
        min_english_requirements_json: r.min_english_requirements_json,
        required_entrance_exams_json: r.required_entrance_exams_json,
        schooling_11yr_override: r.schooling_11yr_override,
        app_window_open_at: iso(r.app_window_open_at),
        app_window_close_at: r.app_window_close_at.toISOString(),
        qualified_docs_deadline_at: iso(r.qualified_docs_deadline_at),
        classes_start_date: r.classes_start_date,
        official_portal_fee_eur_cents:
          r.official_portal_fee_eur_cents === null ? null : Number(r.official_portal_fee_eur_cents),
      }),
      university: {
        id: r.university_id,
        countryIso2: r.uni_country,
        creditCardAccepted: r.credit_card_accepted,
        minorConsents: Consents.parse(r.uni_consents),
      },
      city:
        r.city_consents === null
          ? null
          : { monthlyLivingMinEur: r.monthly_living_min_eur, minorConsents: Consents.parse(r.city_consents) },
      housing: { monthlyMinEur: r.housing_min_eur === null ? null : Number(r.housing_min_eur) },
    }));

    const origins = await this.db
      .selectFrom('wiki.origin_equivalency_rule')
      .selectAll()
      .where('admission_season', '=', season)
      .where('verification_depth', '<>', 'QUARANTINED')
      .execute();
    const originRules = origins.map((o): OriginRuleView => ({
      destinationCountryIso2: o.destination_country_iso2,
      citizenshipCountry: o.citizenship_country,
      diplomaOriginCountry: o.diploma_origin_country,
      diplomaType: o.diploma_type,
      admissionSeason: o.admission_season,
      equivalencyPolicy: EquivalencyPolicy.parse(o.equivalency_policy),
      nationalRecognitionLeadDays: o.national_recognition_lead_days,
      ruSectorTranslationExempt: o.ru_sector_translation_exempt,
      minorConsents: Consents.parse(o.minor_consents_json),
      depth: VerificationDepth.parse(o.verification_depth),
    }));
    return { candidates, originRules };
  }
}

/** L2: cosine similarity over `wiki.program_embedding` vectors, falling back to pg_trgm on `search_text`. */
export class SqlSimilarity implements SimilarityPort {
  constructor(private readonly db: Database) {}

  async score(
    programIds: readonly string[],
    query: string,
    queryEmbedding: readonly number[] | null,
  ): Promise<Map<string, SimilarityScore>> {
    const out = new Map<string, SimilarityScore>();
    if (programIds.length === 0) return out;
    if (queryEmbedding !== null) {
      const vector = `[${queryEmbedding.join(',')}]`;
      const rows = await this.db
        .selectFrom('wiki.program_embedding')
        .select(['program_id', sql<number>`1 - (embedding <=> ${vector}::vector)`.as('sim')])
        .where('program_id', 'in', [...programIds])
        .where('embedding', 'is not', null)
        .execute();
      for (const r of rows)
        out.set(r.program_id, { score: Math.max(0, Math.min(1, Number(r.sim))), method: 'PGVECTOR' });
    }
    const missing = programIds.filter((id) => !out.has(id));
    if (missing.length > 0) {
      const rows = await this.db
        .selectFrom('wiki.program_embedding')
        .select(['program_id', sql<number>`word_similarity(${query}, search_text)`.as('sim')])
        .where('program_id', 'in', missing)
        .execute();
      for (const r of rows)
        out.set(r.program_id, { score: Math.max(0, Math.min(1, Number(r.sim))), method: 'PG_TRGM' });
    }
    return out;
  }
}
