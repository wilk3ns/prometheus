import {
  Citation,
  CityProfileFields,
  CountryRuleFields,
  DiscoveredLink,
  HousingFields,
  OriginEquivalencyFields,
  ProgramSpecNodeFields,
  SlotCompleteness,
  SnapshotErrorCode,
  UniversityFields,
  VerificationDepth,
  WikiStatus,
  type LayerFieldsMap,
  type SliceCard,
  type WikiLayer,
} from '@prometheus/contracts';
import type { Database, WikiUniversityHousing } from '@prometheus/db';
import type { BlobStorePort } from '@prometheus/infra-ports';
import type { IdGen } from '@prometheus/kernel';
import { sql, type Selectable } from 'kysely';
import { z } from 'zod';
import {
  NodeVersionConflictError,
  type CardTarget,
  type NodeWrite,
  type QuarantineWrite,
  type SnapshotReaderPort,
  type StoredNode,
  type StoredSnapshot,
  type WikiLayerRepository,
  type WikiLayerStore,
} from './wiki-layer-repository.js';

/**
 * WikiLayerRepository over Kysely. MUST be given a connection authenticated as `wiki_writer` (connectAs):
 * app_core holds no write privilege on `wiki.*` at all, and `wiki.node_revision` is append-only even here.
 */

type Executor = Database;

const Paths = z.array(z.string());
const Citations = z.array(Citation);

function iso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

function num(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

interface CommonRow {
  id: string;
  verification_depth: string;
  verification_score: string | null;
  citations_json: unknown;
  slot_completeness_json: unknown;
  locked_fields_json: unknown;
  version: number;
}

function common<L extends WikiLayer>(
  layer: L,
  nodeKey: string,
  row: CommonRow,
  fields: LayerFieldsMap[L],
  wikiStatus: string | null,
): StoredNode<L> {
  return {
    layer,
    nodeKey,
    rowId: row.id,
    version: row.version,
    depth: VerificationDepth.parse(row.verification_depth),
    score: num(row.verification_score),
    wikiStatus: wikiStatus === null ? null : WikiStatus.parse(wikiStatus),
    fields,
    lockedPaths: Paths.parse(row.locked_fields_json),
    citations: Citations.parse(row.citations_json),
    slotCompleteness: SlotCompleteness.parse(row.slot_completeness_json),
  };
}

function meta(w: NodeWrite) {
  return {
    verification_depth: w.depth,
    verification_score: w.score === null ? null : w.score.toFixed(3),
    citations_json: json(w.citations),
    slot_completeness_json: json(w.slotCompleteness),
    locked_fields_json: json(w.lockedPaths),
    verified_at: w.verifiedAt,
  };
}

function splitLast(key: string): [string, string] {
  const i = key.lastIndexOf(':');
  if (i <= 0) throw new RangeError(`malformed node key '${key}'`);
  return [key.slice(0, i), key.slice(i + 1)];
}

interface LayerTable<L extends WikiLayer> {
  find(db: Executor, nodeKey: string): Promise<StoredNode<L> | undefined>;
  /** Inserts a new node row; returns its row id. */
  insert(db: Executor, w: NodeWrite<L>, newId: string): Promise<string>;
  /** Optimistic update (WHERE version = expected); false if the row moved on. */
  update(db: Executor, w: NodeWrite<L>, rowId: string): Promise<boolean>;
  quarantine(db: Executor, rowId: string, expectedVersion: number): Promise<boolean>;
}

const country: LayerTable<'COUNTRY'> = {
  async find(db, nodeKey) {
    const [iso2, season] = splitLast(nodeKey);
    const r = await db
      .selectFrom('wiki.destination_country_rule')
      .selectAll()
      .where('country_iso2', '=', iso2)
      .where('admission_season', '=', season)
      .executeTakeFirst();
    if (!r) return undefined;
    const fields = CountryRuleFields.parse({
      country_iso2: r.country_iso2,
      admission_season: r.admission_season,
      rules_payload_json: r.rules_payload_json,
    });
    return common('COUNTRY', nodeKey, r, fields, null);
  },
  async insert(db, w, id) {
    await db
      .insertInto('wiki.destination_country_rule')
      .values({ id, ...w.fields, rules_payload_json: json(w.fields.rules_payload_json), ...meta(w) })
      .execute();
    return id;
  },
  async update(db, w, rowId) {
    const r = await db
      .updateTable('wiki.destination_country_rule')
      .set({
        rules_payload_json: json(w.fields.rules_payload_json),
        ...meta(w),
        version: w.expectedVersion + 1,
      })
      .where('id', '=', rowId)
      .where('version', '=', w.expectedVersion)
      .executeTakeFirst();
    return r.numUpdatedRows === 1n;
  },
  async quarantine(db, rowId, v) {
    const r = await db
      .updateTable('wiki.destination_country_rule')
      .set({ verification_depth: 'QUARANTINED', version: v + 1 })
      .where('id', '=', rowId)
      .where('version', '=', v)
      .executeTakeFirst();
    return r.numUpdatedRows === 1n;
  },
};

const city: LayerTable<'CITY'> = {
  async find(db, nodeKey) {
    const r = await db
      .selectFrom('wiki.city_profile')
      .selectAll()
      .where('id', '=', nodeKey)
      .executeTakeFirst();
    if (!r) return undefined;
    const fields = CityProfileFields.parse({
      id: r.id,
      country_iso2: r.country_iso2,
      city_name_en: r.city_name_en,
      monthly_living_min_eur: r.monthly_living_min_eur,
      monthly_living_max_eur: r.monthly_living_max_eur,
      minor_consents_json: r.minor_consents_json,
      attributes_json: r.attributes_json,
    });
    return common('CITY', nodeKey, r, fields, null);
  },
  async insert(db, w) {
    const f = w.fields;
    await db
      .insertInto('wiki.city_profile')
      .values({
        ...f,
        minor_consents_json: json(f.minor_consents_json),
        attributes_json: json(f.attributes_json),
        ...meta(w),
      })
      .execute();
    return f.id;
  },
  async update(db, w, rowId) {
    const f = w.fields;
    const r = await db
      .updateTable('wiki.city_profile')
      .set({
        country_iso2: f.country_iso2,
        city_name_en: f.city_name_en,
        monthly_living_min_eur: f.monthly_living_min_eur,
        monthly_living_max_eur: f.monthly_living_max_eur,
        minor_consents_json: json(f.minor_consents_json),
        attributes_json: json(f.attributes_json),
        ...meta(w),
        version: w.expectedVersion + 1,
      })
      .where('id', '=', rowId)
      .where('version', '=', w.expectedVersion)
      .executeTakeFirst();
    return r.numUpdatedRows === 1n;
  },
  async quarantine(db, rowId, v) {
    const r = await db
      .updateTable('wiki.city_profile')
      .set({ verification_depth: 'QUARANTINED', version: v + 1, agent_slice_card_json: null })
      .where('id', '=', rowId)
      .where('version', '=', v)
      .executeTakeFirst();
    return r.numUpdatedRows === 1n;
  },
};

const origin: LayerTable<'ORIGIN_EQUIVALENCY'> = {
  async find(db, nodeKey) {
    const [dest, citizenship, originCountry, diploma, season, extra] = nodeKey.split(':');
    if (
      dest === undefined ||
      citizenship === undefined ||
      originCountry === undefined ||
      diploma === undefined ||
      season === undefined ||
      extra !== undefined
    ) {
      throw new RangeError(`malformed origin node key '${nodeKey}'`);
    }
    const r = await db
      .selectFrom('wiki.origin_equivalency_rule')
      .selectAll()
      .where('destination_country_iso2', '=', dest)
      .where('citizenship_country', '=', citizenship)
      .where('diploma_origin_country', '=', originCountry)
      .where('diploma_type', '=', diploma)
      .where('admission_season', '=', season)
      .executeTakeFirst();
    if (!r) return undefined;
    const fields = OriginEquivalencyFields.parse({
      destination_country_iso2: r.destination_country_iso2,
      citizenship_country: r.citizenship_country,
      diploma_origin_country: r.diploma_origin_country,
      diploma_type: r.diploma_type,
      admission_season: r.admission_season,
      equivalency_policy: r.equivalency_policy,
      national_recognition_lead_days: r.national_recognition_lead_days,
      ru_sector_translation_exempt: r.ru_sector_translation_exempt,
      paper_apostille_accepted: r.paper_apostille_accepted,
      e_apostille_accepted: r.e_apostille_accepted,
      minor_consents_json: r.minor_consents_json,
      legalization_rules_json: r.legalization_rules_json,
    });
    return common('ORIGIN_EQUIVALENCY', nodeKey, r, fields, null);
  },
  async insert(db, w, id) {
    const f = w.fields;
    await db
      .insertInto('wiki.origin_equivalency_rule')
      .values({
        id,
        ...f,
        minor_consents_json: json(f.minor_consents_json),
        legalization_rules_json: json(f.legalization_rules_json),
        ...meta(w),
      })
      .execute();
    return id;
  },
  async update(db, w, rowId) {
    const f = w.fields;
    const r = await db
      .updateTable('wiki.origin_equivalency_rule')
      .set({
        equivalency_policy: f.equivalency_policy,
        national_recognition_lead_days: f.national_recognition_lead_days,
        ru_sector_translation_exempt: f.ru_sector_translation_exempt,
        paper_apostille_accepted: f.paper_apostille_accepted,
        e_apostille_accepted: f.e_apostille_accepted,
        minor_consents_json: json(f.minor_consents_json),
        legalization_rules_json: json(f.legalization_rules_json),
        ...meta(w),
        version: w.expectedVersion + 1,
      })
      .where('id', '=', rowId)
      .where('version', '=', w.expectedVersion)
      .executeTakeFirst();
    return r.numUpdatedRows === 1n;
  },
  async quarantine(db, rowId, v) {
    const r = await db
      .updateTable('wiki.origin_equivalency_rule')
      .set({ verification_depth: 'QUARANTINED', version: v + 1 })
      .where('id', '=', rowId)
      .where('version', '=', v)
      .executeTakeFirst();
    return r.numUpdatedRows === 1n;
  },
};

function universityValues(f: LayerFieldsMap['UNIVERSITY']) {
  return {
    name_en: f.name_en,
    name_local: f.name_local,
    country_iso2: f.country_iso2,
    city_id: f.city_id,
    institution_type: f.institution_type,
    official_domain: f.official_domain,
    official_email_domains_json: json(f.official_email_domains_json),
    primary_portal_type: f.primary_portal_type,
    portal_url: f.portal_url,
    sends_email_notifications: f.sends_email_notifications,
    credit_card_accepted: f.credit_card_accepted,
    pricing_tier_code: f.pricing_tier_code,
    minor_consents_json: json(f.minor_consents_json),
    general_rules_json: json(f.general_rules_json),
  };
}

const university: LayerTable<'UNIVERSITY'> = {
  async find(db, nodeKey) {
    const r = await db.selectFrom('wiki.university').selectAll().where('id', '=', nodeKey).executeTakeFirst();
    if (!r) return undefined;
    const fields = UniversityFields.parse({
      id: r.id,
      name_en: r.name_en,
      name_local: r.name_local,
      country_iso2: r.country_iso2,
      city_id: r.city_id,
      institution_type: r.institution_type,
      official_domain: r.official_domain,
      official_email_domains_json: r.official_email_domains_json,
      primary_portal_type: r.primary_portal_type,
      portal_url: r.portal_url,
      sends_email_notifications: r.sends_email_notifications,
      credit_card_accepted: r.credit_card_accepted,
      pricing_tier_code: r.pricing_tier_code,
      minor_consents_json: r.minor_consents_json,
      general_rules_json: r.general_rules_json,
    });
    return common('UNIVERSITY', nodeKey, r, fields, null);
  },
  async insert(db, w) {
    await db
      .insertInto('wiki.university')
      .values({ id: w.fields.id, ...universityValues(w.fields), ...meta(w) })
      .execute();
    return w.fields.id;
  },
  async update(db, w, rowId) {
    const r = await db
      .updateTable('wiki.university')
      .set({ ...universityValues(w.fields), ...meta(w), version: w.expectedVersion + 1 })
      .where('id', '=', rowId)
      .where('version', '=', w.expectedVersion)
      .executeTakeFirst();
    return r.numUpdatedRows === 1n;
  },
  async quarantine(db, rowId, v) {
    const r = await db
      .updateTable('wiki.university')
      .set({ verification_depth: 'QUARANTINED', version: v + 1, agent_slice_card_json: null })
      .where('id', '=', rowId)
      .where('version', '=', v)
      .executeTakeFirst();
    return r.numUpdatedRows === 1n;
  },
};

function housingValues(f: LayerFieldsMap['HOUSING']) {
  return {
    portal_url: f.portal_url,
    official_info_url: f.official_info_url,
    rate_pdf_url: f.rate_pdf_url,
    total_places: f.total_places,
    subsidized_places: f.subsidized_places,
    monthly_min_eur: f.monthly_min_eur,
    monthly_max_eur: f.monthly_max_eur,
    non_refundable_on_visa_denial: f.non_refundable_on_visa_denial,
    critical_rules_json: json(f.critical_rules_json),
    halls_json: json(f.halls_json),
  };
}

function housingNode(r: Selectable<WikiUniversityHousing>): StoredNode<'HOUSING'> {
  const fields = HousingFields.parse({
    university_id: r.university_id,
    rates_season: r.rates_season,
    portal_url: r.portal_url,
    official_info_url: r.official_info_url,
    rate_pdf_url: r.rate_pdf_url,
    total_places: r.total_places,
    subsidized_places: r.subsidized_places,
    monthly_min_eur: r.monthly_min_eur,
    monthly_max_eur: r.monthly_max_eur,
    non_refundable_on_visa_denial: r.non_refundable_on_visa_denial,
    critical_rules_json: r.critical_rules_json,
    halls_json: r.halls_json,
  });
  return common('HOUSING', `${r.university_id}:${r.rates_season}`, r, fields, null);
}

const housing: LayerTable<'HOUSING'> = {
  async find(db, nodeKey) {
    const [uni, rates] = splitLast(nodeKey);
    const r = await db
      .selectFrom('wiki.university_housing')
      .selectAll()
      .where('university_id', '=', uni)
      .where('rates_season', '=', rates)
      .executeTakeFirst();
    return r ? housingNode(r) : undefined;
  },
  async insert(db, w, id) {
    await db
      .insertInto('wiki.university_housing')
      .values({
        id,
        university_id: w.fields.university_id,
        rates_season: w.fields.rates_season,
        ...housingValues(w.fields),
        ...meta(w),
      })
      .execute();
    return id;
  },
  async update(db, w, rowId) {
    const r = await db
      .updateTable('wiki.university_housing')
      .set({ ...housingValues(w.fields), ...meta(w), version: w.expectedVersion + 1 })
      .where('id', '=', rowId)
      .where('version', '=', w.expectedVersion)
      .executeTakeFirst();
    return r.numUpdatedRows === 1n;
  },
  async quarantine(db, rowId, v) {
    const r = await db
      .updateTable('wiki.university_housing')
      .set({ verification_depth: 'QUARANTINED', version: v + 1, agent_slice_card_json: null })
      .where('id', '=', rowId)
      .where('version', '=', v)
      .executeTakeFirst();
    return r.numUpdatedRows === 1n;
  },
};

function specValues(f: LayerFieldsMap['PROGRAM_SPEC']) {
  return {
    tuition_annual_eur: f.tuition_annual_eur,
    scholarship_waiver_codes_json: json(f.scholarship_waiver_codes_json),
    accepted_prior_fields_json: json(f.accepted_prior_fields_json),
    predicted_grades_accepted: f.predicted_grades_accepted,
    min_gpa_100: f.min_gpa_100 === null ? null : f.min_gpa_100.toFixed(2),
    min_math_100: f.min_math_100 === null ? null : f.min_math_100.toFixed(2),
    high_school_emi_accepted: f.high_school_emi_accepted,
    min_bsc_emi_pct: f.min_bsc_emi_pct,
    min_english_requirements_json: json(f.min_english_requirements_json),
    required_entrance_exams_json: json(f.required_entrance_exams_json),
    schooling_11yr_override: f.schooling_11yr_override,
    app_window_open_at: f.app_window_open_at,
    app_window_close_at: f.app_window_close_at,
    qualified_docs_deadline_at: f.qualified_docs_deadline_at,
    classes_start_date: f.classes_start_date,
    official_portal_fee_eur_cents: f.official_portal_fee_eur_cents,
    program_requirements_json: json(f.program_requirements_json),
  };
}

async function upsertProgram(db: Executor, p: LayerFieldsMap['PROGRAM_SPEC']['program']): Promise<void> {
  const values = {
    university_id: p.university_id,
    name_en: p.name_en,
    name_local: p.name_local,
    degree_level: p.degree_level,
    field_code: p.field_code,
    instruction_language: p.instruction_language,
    duration_semesters: p.duration_semesters,
    ects_total: p.ects_total,
    official_program_url: p.official_program_url,
  };
  await db
    .insertInto('wiki.program')
    .values({ id: p.id, ...values })
    .onConflict((oc) => oc.column('id').doUpdateSet(values))
    .execute();
}

function selectSpecs(db: Executor) {
  return db
    .selectFrom('wiki.program_season_spec as s')
    .innerJoin('wiki.program as p', 'p.id', 's.program_id')
    .selectAll('s')
    .select([
      'p.university_id',
      'p.name_en',
      'p.name_local',
      'p.degree_level',
      'p.field_code',
      'p.instruction_language',
      'p.duration_semesters',
      'p.ects_total',
      'p.official_program_url',
    ]);
}
type SpecRow = Awaited<ReturnType<ReturnType<typeof selectSpecs>['execute']>>[number];

function specNode(r: SpecRow): StoredNode<'PROGRAM_SPEC'> {
  const fields = ProgramSpecNodeFields.parse({
    program_id: r.program_id,
    admission_season: r.admission_season,
    tuition_annual_eur: r.tuition_annual_eur,
    scholarship_waiver_codes_json: r.scholarship_waiver_codes_json,
    accepted_prior_fields_json: r.accepted_prior_fields_json,
    predicted_grades_accepted: r.predicted_grades_accepted,
    min_gpa_100: num(r.min_gpa_100),
    min_math_100: num(r.min_math_100),
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
    program_requirements_json: r.program_requirements_json,
    program: {
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
    },
  });
  return common('PROGRAM_SPEC', `${r.program_id}:${r.admission_season}`, r, fields, r.wiki_status);
}

const programSpec: LayerTable<'PROGRAM_SPEC'> = {
  async find(db, nodeKey) {
    const [programId, season] = splitLast(nodeKey);
    const r = await selectSpecs(db)
      .where('s.program_id', '=', programId)
      .where('s.admission_season', '=', season)
      .executeTakeFirst();
    return r ? specNode(r) : undefined;
  },
  async insert(db, w, id) {
    if (w.wikiStatus === null) throw new RangeError('PROGRAM_SPEC writes require a wiki_status');
    await upsertProgram(db, w.fields.program);
    await db
      .insertInto('wiki.program_season_spec')
      .values({
        id,
        program_id: w.fields.program_id,
        admission_season: w.fields.admission_season,
        wiki_status: w.wikiStatus,
        ...specValues(w.fields),
        ...meta(w),
      })
      .execute();
    return id;
  },
  async update(db, w, rowId) {
    if (w.wikiStatus === null) throw new RangeError('PROGRAM_SPEC writes require a wiki_status');
    await upsertProgram(db, w.fields.program);
    const r = await db
      .updateTable('wiki.program_season_spec')
      .set({ wiki_status: w.wikiStatus, ...specValues(w.fields), ...meta(w), version: w.expectedVersion + 1 })
      .where('id', '=', rowId)
      .where('version', '=', w.expectedVersion)
      .executeTakeFirst();
    return r.numUpdatedRows === 1n;
  },
  async quarantine(db, rowId, v) {
    // A quarantined spec is never ACTIVE: it drops out of student matching immediately.
    const r = await db
      .updateTable('wiki.program_season_spec')
      .set({
        verification_depth: 'QUARANTINED',
        wiki_status: 'DRAFT',
        version: v + 1,
        agent_slice_card_json: null,
      })
      .where('id', '=', rowId)
      .where('version', '=', v)
      .executeTakeFirst();
    return r.numUpdatedRows === 1n;
  },
};

const TABLES: { [L in WikiLayer]: LayerTable<L> } = {
  COUNTRY: country,
  CITY: city,
  ORIGIN_EQUIVALENCY: origin,
  UNIVERSITY: university,
  HOUSING: housing,
  PROGRAM_SPEC: programSpec,
};

class KyselyLayerStore implements WikiLayerStore {
  constructor(
    protected readonly db: Executor,
    protected readonly ids: IdGen,
  ) {}

  findNode<L extends WikiLayer>(layer: L, nodeKey: string): Promise<StoredNode<L> | undefined> {
    const table: LayerTable<L> = TABLES[layer];
    return table.find(this.db, nodeKey);
  }

  async writeNode<L extends WikiLayer>(w: NodeWrite<L>): Promise<{ rowId: string; version: number }> {
    const table: LayerTable<L> = TABLES[w.layer];
    const before = await table.find(this.db, w.nodeKey);
    let rowId: string;
    let version: number;
    if (w.expectedVersion === 0) {
      if (before !== undefined) throw new NodeVersionConflictError(w.layer, w.nodeKey, 0);
      rowId = await table.insert(this.db, w, this.ids.next());
      version = 1;
    } else {
      if (before === undefined || before.version !== w.expectedVersion) {
        throw new NodeVersionConflictError(w.layer, w.nodeKey, w.expectedVersion);
      }
      if (!(await table.update(this.db, w, before.rowId))) {
        throw new NodeVersionConflictError(w.layer, w.nodeKey, w.expectedVersion);
      }
      rowId = before.rowId;
      version = w.expectedVersion + 1;
    }
    await this.revision(
      w.layer,
      w.nodeKey,
      version,
      w.actor,
      before?.fields ?? null,
      {
        fields: w.fields,
        verification_depth: w.depth,
        verification_score: w.score,
        wiki_status: w.wikiStatus,
        citations: w.citations,
        slot_completeness: w.slotCompleteness,
      },
      w.reason,
    );
    return { rowId, version };
  }

  quarantineNode(q: QuarantineWrite): Promise<number> {
    return this.quarantineIn(q.layer, q);
  }

  private async quarantineIn<L extends WikiLayer>(layer: L, q: QuarantineWrite): Promise<number> {
    const table: LayerTable<L> = TABLES[layer];
    const before = await table.find(this.db, q.nodeKey);
    if (before === undefined || before.version !== q.expectedVersion) {
      throw new NodeVersionConflictError(q.layer, q.nodeKey, q.expectedVersion);
    }
    if (!(await table.quarantine(this.db, before.rowId, q.expectedVersion))) {
      throw new NodeVersionConflictError(q.layer, q.nodeKey, q.expectedVersion);
    }
    const version = q.expectedVersion + 1;
    await this.revision(
      q.layer,
      q.nodeKey,
      version,
      q.actor,
      before.fields,
      {
        verification_depth: 'QUARANTINED',
        evidence: q.evidence,
      },
      q.reason,
    );
    return version;
  }

  async recordRejectedProposal(q: QuarantineWrite): Promise<void> {
    await this.revision(
      q.layer,
      q.nodeKey,
      0,
      q.actor,
      null,
      { verification_depth: 'QUARANTINED', evidence: q.evidence },
      q.reason,
    );
  }

  private async revision(
    layer: WikiLayer,
    nodeKey: string,
    version: number,
    actor: string,
    before: unknown,
    after: unknown,
    reason: string,
  ): Promise<void> {
    await this.db
      .insertInto('wiki.node_revision')
      .values({
        id: this.ids.next(),
        layer,
        node_key: nodeKey,
        version,
        actor,
        before_json: before === null ? null : json(before),
        after_json: json(after),
        reason,
      })
      .execute();
  }

  async setCard(target: CardTarget, card: SliceCard | null): Promise<void> {
    const value = card === null ? null : json(card);
    switch (target.kind) {
      case 'docs':
        await this.db
          .updateTable('wiki.program_season_spec')
          .set({ agent_slice_card_json: value })
          .where('id', '=', target.rowId)
          .execute();
        return;
      case 'tuition_aid':
        await this.db
          .updateTable('wiki.university')
          .set({ agent_slice_card_json: value })
          .where('id', '=', target.rowId)
          .execute();
        return;
      case 'city':
        await this.db
          .updateTable('wiki.city_profile')
          .set({ agent_slice_card_json: value })
          .where('id', '=', target.rowId)
          .execute();
        return;
      case 'dorms':
        await this.db
          .updateTable('wiki.university_housing')
          .set({ agent_slice_card_json: value })
          .where('id', '=', target.rowId)
          .execute();
        return;
    }
  }

  async upsertProgramSearchText(programId: string, searchText: string): Promise<void> {
    await this.db
      .insertInto('wiki.program_embedding')
      .values({ program_id: programId, model_id: 'none:pg_trgm', embedding: null, search_text: searchText })
      .onConflict((oc) =>
        oc.column('program_id').doUpdateSet({
          search_text: searchText,
          updated_at: sql`now()`,
          // a changed search text invalidates a stale vector; it is re-embedded on the next embed step
          embedding: sql`CASE WHEN wiki.program_embedding.search_text = excluded.search_text THEN wiki.program_embedding.embedding ELSE NULL END`,
        }),
      )
      .execute();
  }

  async listHousing(universityId: string): Promise<StoredNode<'HOUSING'>[]> {
    const rows = await this.db
      .selectFrom('wiki.university_housing')
      .selectAll()
      .where('university_id', '=', universityId)
      .orderBy('rates_season', 'desc')
      .execute();
    return rows.map(housingNode);
  }

  async listSpecs(universityId: string, season: string): Promise<StoredNode<'PROGRAM_SPEC'>[]> {
    const rows = await selectSpecs(this.db)
      .where('p.university_id', '=', universityId)
      .where('s.admission_season', '=', season)
      .orderBy('s.program_id')
      .execute();
    return rows.map(specNode);
  }
}

export class KyselyWikiLayerRepository extends KyselyLayerStore implements WikiLayerRepository {
  transaction<T>(work: (store: WikiLayerStore) => Promise<T>): Promise<T> {
    return this.db.transaction().execute((trx) => work(new KyselyLayerStore(trx, this.ids)));
  }

  async setProgramEmbedding(programId: string, modelId: string, embedding: readonly number[]): Promise<void> {
    await this.db
      .updateTable('wiki.program_embedding')
      .set({ model_id: modelId, embedding: `[${embedding.join(',')}]`, updated_at: sql`now()` })
      .where('program_id', '=', programId)
      .execute();
  }
}

const SeedUrls = z.array(z.string());
const Links = z.array(DiscoveredLink);
const ContentKindRow = z.enum(['HTML', 'PDF', 'HTTP_ERROR']);

/** Snapshot reads for the curator: rows from Postgres, clean text from the blob store (`<bucket>/<key>`). */
export class KyselySnapshotReader implements SnapshotReaderPort {
  constructor(
    private readonly db: Database,
    private readonly blobs: BlobStorePort,
  ) {}

  async listTargetSnapshots(
    targetKey: string,
  ): Promise<{ seedUrls: readonly string[]; rows: StoredSnapshot[] } | undefined> {
    const target = await this.db
      .selectFrom('wiki.crawl_target')
      .select(['id', 'seed_urls_json'])
      .where('target_key', '=', targetKey)
      .executeTakeFirst();
    if (!target) return undefined;
    const rows = await this.db
      .selectFrom('wiki.source_snapshot')
      .select([
        'id',
        'requested_url',
        'final_url',
        'content_kind',
        'error_code',
        'clean_text_blob_ref',
        'discovered_links_json',
        'fetched_at',
      ])
      .where('target_id', '=', target.id)
      .orderBy('fetched_at')
      .orderBy('id')
      .execute();
    return {
      seedUrls: SeedUrls.parse(target.seed_urls_json),
      rows: rows.map((r) => ({
        id: r.id,
        requestedUrl: r.requested_url,
        finalUrl: r.final_url,
        contentKind: ContentKindRow.parse(r.content_kind),
        errorCode: r.error_code === null ? null : SnapshotErrorCode.parse(r.error_code),
        cleanTextBlobRef: r.clean_text_blob_ref,
        discoveredLinks: Links.parse(r.discovered_links_json),
        fetchedAt: r.fetched_at.toISOString(),
      })),
    };
  }

  async readCleanText(blobRef: string): Promise<string> {
    const prefix = `${this.blobs.bucket}/`;
    if (!blobRef.startsWith(prefix))
      throw new RangeError(`blob ref ${blobRef} is not in bucket ${this.blobs.bucket}`);
    const bytes = await this.blobs.get(blobRef.slice(prefix.length));
    if (bytes === undefined) throw new Error(`snapshot text blob missing: ${blobRef}`);
    return Buffer.from(bytes).toString('utf8');
  }
}
