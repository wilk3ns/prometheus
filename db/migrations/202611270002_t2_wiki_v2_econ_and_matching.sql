-- migrate:up
CREATE SCHEMA IF NOT EXISTS econ;
CREATE SCHEMA IF NOT EXISTS matching;

-- Allow both app_core and wiki_writer to record AI cost & usage telemetry
GRANT USAGE ON SCHEMA econ TO app_core, wiki_writer;
GRANT USAGE ON SCHEMA matching TO app_core;

-- 1. AI Economics & Per-Call Budget Caps
CREATE TABLE econ.rate_card (
  provider          text NOT NULL,
  model_or_sku      text NOT NULL,
  unit              text NOT NULL CHECK (unit IN ('INPUT_1M_TOKENS','OUTPUT_1M_TOKENS','EMBED_1M_TOKENS','VOICE_MINUTE')),
  usd_per_unit      numeric(12,6) NOT NULL CHECK (usd_per_unit >= 0),
  valid_from        date NOT NULL DEFAULT '2026-01-01',
  PRIMARY KEY (provider, model_or_sku, unit, valid_from)
);

CREATE TABLE econ.call_budget (
  call_key          text PRIMARY KEY,
  route             text NOT NULL,
  cap_usd           numeric(10,6) NOT NULL CHECK (cap_usd > 0),
  reserved_usd      numeric(10,6) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0 AND reserved_usd <= cap_usd),
  attempts_count    smallint NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE econ.ai_usage_ledger (
  id                uuid PRIMARY KEY,
  idempotency_key   text NOT NULL UNIQUE,
  call_key          text,
  subsystem         text NOT NULL CHECK (subsystem IN ('WIKI_BASELINE','WIKI_DEEP_VERIFY','MATCHING','VOICE','DOC_VLM','COUNSELOR')),
  route             text NOT NULL,
  provider          text NOT NULL,
  family            text NOT NULL CHECK (family IN ('openai-gpt','google-gemini','replay')),
  model_or_sku      text NOT NULL,
  prompt_id         text NOT NULL,
  prompt_version    text NOT NULL,
  prompt_hash       char(64) NOT NULL,
  input_tokens      integer NOT NULL DEFAULT 0,
  output_tokens     integer NOT NULL DEFAULT 0,
  estimated_cost_usd numeric(10,6) NOT NULL DEFAULT 0,
  latency_ms        integer NOT NULL DEFAULT 0,
  outcome           text NOT NULL CHECK (outcome IN ('OK','SCHEMA_INVALID','ABSTAIN','BUDGET','DEADLINE','POLICY_DENIED','ERROR')),
  created_at        timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON econ.rate_card TO app_core, wiki_writer;
GRANT SELECT, INSERT, UPDATE ON econ.rate_card TO wiki_writer;
GRANT SELECT, INSERT, UPDATE ON econ.call_budget TO app_core, wiki_writer;
GRANT SELECT, INSERT ON econ.ai_usage_ledger TO app_core, wiki_writer;

-- 2. Canonical wiki-v2.0 6-Layer Tables (Written ONLY by wiki_writer)

-- Layer 1: Destination Country
CREATE TABLE wiki.destination_country_rule (
  id                  uuid PRIMARY KEY,
  country_iso2        char(2) NOT NULL CHECK (country_iso2 IN ('IT','DE','PL','HU','TR')),
  admission_season    varchar(32) NOT NULL,
  verification_depth  text NOT NULL CHECK (verification_depth IN ('BASELINE','DEEP_VERIFIED','QUARANTINED')),
  verification_score  numeric(4,3) CHECK (verification_score BETWEEN 0 AND 1),
  rules_payload_json  jsonb NOT NULL,
  citations_json      jsonb NOT NULL DEFAULT '[]'::jsonb,
  slot_completeness_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  locked_fields_json  jsonb NOT NULL DEFAULT '[]'::jsonb,
  version             integer NOT NULL DEFAULT 1,
  verified_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (country_iso2, admission_season),
  CHECK (verification_depth <> 'DEEP_VERIFIED' OR verification_score >= 0.950)
);

-- Layer 1b: City Profile + card:city (<350 tokens)
CREATE TABLE wiki.city_profile (
  id                  text PRIMARY KEY, -- e.g. 'IT-MILAN', 'PL-WARSAW'
  country_iso2        char(2) NOT NULL CHECK (country_iso2 IN ('IT','DE','PL','HU','TR')),
  city_name_en        text NOT NULL,
  monthly_living_min_eur integer,
  monthly_living_max_eur integer,
  minor_consents_json jsonb NOT NULL DEFAULT '[]'::jsonb, -- e.g. NFZ parent consent + passport copy
  attributes_json     jsonb NOT NULL,
  citations_json      jsonb NOT NULL DEFAULT '[]'::jsonb,
  slot_completeness_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_slice_card_json jsonb,          -- { kind: 'city', text, est_tokens <= 350, version }
  verification_depth  text NOT NULL CHECK (verification_depth IN ('BASELINE','DEEP_VERIFIED','QUARANTINED')),
  verification_score  numeric(4,3) CHECK (verification_score BETWEEN 0 AND 1),
  locked_fields_json  jsonb NOT NULL DEFAULT '[]'::jsonb,
  version             integer NOT NULL DEFAULT 1,
  verified_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (verification_depth <> 'DEEP_VERIFIED' OR verification_score >= 0.950)
);

-- Layer 2: Origin Equivalency Rule (e.g. AZ -> IT BACHELOR_DEGREE; AZ -> PL CIS_11YR_ATTESTAT)
CREATE TABLE wiki.origin_equivalency_rule (
  id                  uuid PRIMARY KEY,
  destination_country_iso2 char(2) NOT NULL CHECK (destination_country_iso2 IN ('IT','DE','PL','HU','TR')),
  citizenship_country char(2) NOT NULL,
  diploma_origin_country char(2) NOT NULL,
  diploma_type        varchar(64) NOT NULL, -- 'CIS_11YR_ATTESTAT', 'BACHELOR_DEGREE', 'UNI_1YR_COMPLETED', 'IB', 'A_LEVEL'
  admission_season    varchar(32) NOT NULL,
  equivalency_policy  text NOT NULL CHECK (equivalency_policy IN (
                        'DIRECT','DIRECT_WITH_NATIONAL_STATEMENT','FOUNDATION_REQUIRED','ONE_YEAR_UNI_REQUIRED','NOT_ELIGIBLE')),
  national_recognition_lead_days smallint NOT NULL DEFAULT 0 CHECK (national_recognition_lead_days >= 0), -- e.g. 60 for NAWA SYRENA
  ru_sector_translation_exempt boolean NOT NULL DEFAULT false,
  paper_apostille_accepted boolean NOT NULL DEFAULT true,
  e_apostille_accepted boolean NOT NULL DEFAULT true,
  minor_consents_json jsonb NOT NULL DEFAULT '[]'::jsonb, -- e.g. declaration-SYRENA_EN.pdf
  legalization_rules_json jsonb NOT NULL,
  citations_json      jsonb NOT NULL DEFAULT '[]'::jsonb,
  slot_completeness_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification_depth  text NOT NULL CHECK (verification_depth IN ('BASELINE','DEEP_VERIFIED','QUARANTINED')),
  verification_score  numeric(4,3) CHECK (verification_score BETWEEN 0 AND 1),
  locked_fields_json  jsonb NOT NULL DEFAULT '[]'::jsonb,
  version             integer NOT NULL DEFAULT 1,
  verified_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (destination_country_iso2, citizenship_country, diploma_origin_country, diploma_type, admission_season),
  CHECK (verification_depth <> 'DEEP_VERIFIED' OR verification_score >= 0.950)
);

-- Layer 3: University + card:tuition_aid (<350 tokens)
CREATE TABLE wiki.university (
  id                  text PRIMARY KEY, -- e.g. 'polimi', 'wut'
  name_en             text NOT NULL,
  name_local          text,
  country_iso2        char(2) NOT NULL CHECK (country_iso2 IN ('IT','DE','PL','HU','TR')),
  city_id             text NOT NULL REFERENCES wiki.city_profile(id),
  institution_type    text NOT NULL CHECK (institution_type IN ('PUBLIC','PRIVATE')),
  official_domain     text NOT NULL,
  official_email_domains_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  primary_portal_type text NOT NULL CHECK (primary_portal_type IN (
                        'UNI_ASSIST','UNIVERSITALY','DREAMAPPLY','STIPENDIUM_HUNGARICUM','TURKISH_OBS','IRK','DIRECT')),
  portal_url          text,
  sends_email_notifications boolean NOT NULL DEFAULT true,
  credit_card_accepted boolean NOT NULL DEFAULT true,
  pricing_tier_code   text NOT NULL CHECK (pricing_tier_code IN ('T1','T2','T3')),
  minor_consents_json jsonb NOT NULL DEFAULT '[]'::jsonb, -- e.g. WUT ISO original parental consent
  general_rules_json  jsonb NOT NULL,   -- rankings, payment_rails, scholarship brackets, portal rules
  citations_json      jsonb NOT NULL DEFAULT '[]'::jsonb,
  slot_completeness_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_slice_card_json jsonb,          -- { kind: 'tuition_aid', text, est_tokens <= 350, version }
  verification_depth  text NOT NULL CHECK (verification_depth IN ('BASELINE','DEEP_VERIFIED','QUARANTINED')),
  verification_score  numeric(4,3) CHECK (verification_score BETWEEN 0 AND 1),
  locked_fields_json  jsonb NOT NULL DEFAULT '[]'::jsonb,
  version             integer NOT NULL DEFAULT 1,
  verified_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (verification_depth <> 'DEEP_VERIFIED' OR verification_score >= 0.950)
);

-- Layer 3b: University Housing / Dorms + card:dorms (<350 tokens)
CREATE TABLE wiki.university_housing (
  id                  uuid PRIMARY KEY,
  university_id       text NOT NULL REFERENCES wiki.university(id),
  rates_season        varchar(32) NOT NULL, -- e.g. '2026-2027'
  portal_url          text,
  official_info_url   text NOT NULL,
  rate_pdf_url        text,
  total_places        integer,
  subsidized_places   integer,
  monthly_min_eur     integer,
  monthly_max_eur     integer,
  non_refundable_on_visa_denial boolean NOT NULL DEFAULT false,
  critical_rules_json jsonb NOT NULL,
  halls_json          jsonb NOT NULL DEFAULT '[]'::jsonb,
  citations_json      jsonb NOT NULL DEFAULT '[]'::jsonb,
  slot_completeness_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_slice_card_json jsonb,          -- { kind: 'dorms', text, est_tokens <= 350, version }
  verification_depth  text NOT NULL CHECK (verification_depth IN ('BASELINE','DEEP_VERIFIED','QUARANTINED')),
  verification_score  numeric(4,3) CHECK (verification_score BETWEEN 0 AND 1),
  locked_fields_json  jsonb NOT NULL DEFAULT '[]'::jsonb,
  version             integer NOT NULL DEFAULT 1,
  verified_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (university_id, rates_season),
  CHECK (verification_depth <> 'DEEP_VERIFIED' OR verification_score >= 0.950)
);

-- Layer 4: Program & ProgramSeasonSpec + card:docs (<350 tokens)
CREATE TABLE wiki.program (
  id                  text PRIMARY KEY, -- e.g. 'polimi:msc-cse', 'wut:bsc-cs-networks'
  university_id       text NOT NULL REFERENCES wiki.university(id),
  name_en             text NOT NULL,
  name_local          text,
  degree_level        text NOT NULL CHECK (degree_level IN ('BACHELOR','MASTER')),
  field_code          varchar(64) NOT NULL, -- e.g. 'CS_IT', 'POWER_ENG', 'AEROSPACE_ENG'
  instruction_language char(2) NOT NULL,
  duration_semesters  smallint NOT NULL CHECK (duration_semesters BETWEEN 1 AND 12),
  ects_total          smallint,
  official_program_url text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wiki.program_season_spec (
  id                          uuid PRIMARY KEY,
  program_id                  text NOT NULL REFERENCES wiki.program(id),
  admission_season            varchar(32) NOT NULL, -- e.g. '2027-FALL'
  wiki_status                 text NOT NULL DEFAULT 'DRAFT' CHECK (wiki_status IN ('DRAFT','ACTIVE','CLOSED','ARCHIVED')),
  verification_depth          text NOT NULL CHECK (verification_depth IN ('BASELINE','DEEP_VERIFIED','QUARANTINED')),
  verification_score          numeric(4,3) CHECK (verification_score BETWEEN 0 AND 1),
  -- Strictly Typed Deterministic Matching Columns ($0 SQL/Code):
  tuition_annual_eur          integer NOT NULL CHECK (tuition_annual_eur >= 0),
  scholarship_waiver_codes_json jsonb NOT NULL DEFAULT '[]'::jsonb, -- e.g. ["DSU_LOMBARDIA"], ["STIPENDIUM_HUNGARICUM"]
  accepted_prior_fields_json  jsonb NOT NULL, -- { "exact": ["CS_IT"], "adjacent": ["MATH_PHYSICS","ELECTRICAL_ENG"] }
  predicted_grades_accepted   boolean NOT NULL,
  min_gpa_100                 numeric(5,2) CHECK (min_gpa_100 BETWEEN 0 AND 100),
  min_math_100                numeric(5,2) CHECK (min_math_100 BETWEEN 0 AND 100),
  high_school_emi_accepted    boolean NOT NULL DEFAULT false,
  min_bsc_emi_pct             smallint CHECK (min_bsc_emi_pct BETWEEN 1 AND 100),
  min_english_requirements_json jsonb NOT NULL, -- tests + dated scales (TOEFL 2026-01-21) + rejected tests
  required_entrance_exams_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  schooling_11yr_override     text CHECK (schooling_11yr_override IN (
                                'DIRECT','DIRECT_WITH_NATIONAL_STATEMENT','FOUNDATION_REQUIRED','ONE_YEAR_UNI_REQUIRED','NOT_ELIGIBLE')),
  app_window_open_at          timestamptz,
  app_window_close_at         timestamptz NOT NULL, -- active Non-EU deadline
  qualified_docs_deadline_at  timestamptz,          -- e.g. mid-Aug WUT post-qualified upload deadline
  classes_start_date          date,                 -- NULL when exact lecture start day not yet published (e.g. PoliMi); '2027-10-01' at WUT
  official_portal_fee_eur_cents bigint CHECK (official_portal_fee_eur_cents >= 0),
  program_requirements_json   jsonb NOT NULL,       -- calls, excluded EEA calls, document_stages[], upload caps
  citations_json              jsonb NOT NULL DEFAULT '[]'::jsonb,
  slot_completeness_json      jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_slice_card_json       jsonb,                -- { kind: 'docs', text, est_tokens <= 350, version }
  locked_fields_json          jsonb NOT NULL DEFAULT '[]'::jsonb,
  version                     integer NOT NULL DEFAULT 1,
  verified_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, admission_season),
  CHECK (verification_depth <> 'DEEP_VERIFIED' OR verification_score >= 0.950)
);

CREATE TABLE wiki.program_embedding (
  program_id          text PRIMARY KEY REFERENCES wiki.program(id) ON DELETE CASCADE,
  model_id            text NOT NULL,
  embedding           vector(1536),
  search_text         text NOT NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_program_embedding_trgm ON wiki.program_embedding USING gin (search_text gin_trgm_ops);

-- Append-Only Wiki Revision Ledger (Immutable even for wiki_writer!)
CREATE TABLE wiki.node_revision (
  id                  uuid PRIMARY KEY,
  layer               text NOT NULL CHECK (layer IN ('COUNTRY','CITY','ORIGIN_EQUIVALENCY','UNIVERSITY','HOUSING','PROGRAM_SPEC')),
  node_key            text NOT NULL,
  version             integer NOT NULL,
  actor               text NOT NULL CHECK (actor IN ('AI_CURATOR','GOLDEN_FIXTURE','HUMAN')),
  before_json         jsonb,
  after_json          jsonb NOT NULL,
  reason              text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Citation Integrity Trigger on DEEP_VERIFIED (GR-AI-007)
CREATE OR REPLACE FUNCTION wiki.assert_deep_verified_citations() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  c jsonb;
BEGIN
  IF NEW.verification_depth = 'DEEP_VERIFIED' THEN
    IF jsonb_typeof(NEW.citations_json) <> 'array' OR jsonb_array_length(NEW.citations_json) = 0 THEN
      RAISE EXCEPTION 'DEEP_VERIFIED_REQUIRES_CITATIONS' USING ERRCODE = '23514';
    END IF;
    FOR c IN SELECT * FROM jsonb_array_elements(NEW.citations_json) LOOP
      IF coalesce(trim(c->>'source_url'), '') = ''
         OR coalesce(trim(c->>'verbatim_quote'), '') = ''
         OR coalesce(trim(c->>'retrieved_at'), '') = '' THEN
        RAISE EXCEPTION 'CITATION_MISSING_FIELDS' USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_cit_country BEFORE INSERT OR UPDATE ON wiki.destination_country_rule FOR EACH ROW EXECUTE FUNCTION wiki.assert_deep_verified_citations();
CREATE TRIGGER trg_cit_city    BEFORE INSERT OR UPDATE ON wiki.city_profile FOR EACH ROW EXECUTE FUNCTION wiki.assert_deep_verified_citations();
CREATE TRIGGER trg_cit_origin  BEFORE INSERT OR UPDATE ON wiki.origin_equivalency_rule FOR EACH ROW EXECUTE FUNCTION wiki.assert_deep_verified_citations();
CREATE TRIGGER trg_cit_uni     BEFORE INSERT OR UPDATE ON wiki.university FOR EACH ROW EXECUTE FUNCTION wiki.assert_deep_verified_citations();
CREATE TRIGGER trg_cit_housing BEFORE INSERT OR UPDATE ON wiki.university_housing FOR EACH ROW EXECUTE FUNCTION wiki.assert_deep_verified_citations();
CREATE TRIGGER trg_cit_spec    BEFORE INSERT OR UPDATE ON wiki.program_season_spec FOR EACH ROW EXECUTE FUNCTION wiki.assert_deep_verified_citations();

-- Append-Only Guard on wiki.node_revision
CREATE OR REPLACE FUNCTION wiki.forbid_revision_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'NODE_REVISION_APPEND_ONLY' USING ERRCODE = '42501';
END $$;
CREATE TRIGGER trg_node_revision_immutable BEFORE UPDATE OR DELETE ON wiki.node_revision FOR EACH ROW EXECUTE FUNCTION wiki.forbid_revision_mutation();
CREATE TRIGGER trg_node_revision_no_trunc  BEFORE TRUNCATE ON wiki.node_revision FOR EACH STATEMENT EXECUTE FUNCTION wiki.forbid_revision_mutation();

-- Role Grants
GRANT SELECT ON ALL TABLES IN SCHEMA wiki TO wiki_reader;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA wiki TO wiki_writer;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA wiki FROM app_core, PUBLIC;
REVOKE UPDATE, DELETE, TRUNCATE ON wiki.node_revision FROM wiki_writer;
REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA wiki FROM wiki_writer;

-- migrate:down
DROP SCHEMA IF EXISTS matching CASCADE;
DROP SCHEMA IF EXISTS econ CASCADE;
DROP TRIGGER IF EXISTS trg_node_revision_no_trunc ON wiki.node_revision;
DROP TRIGGER IF EXISTS trg_node_revision_immutable ON wiki.node_revision;
DROP FUNCTION IF EXISTS wiki.forbid_revision_mutation();
DROP FUNCTION IF EXISTS wiki.assert_deep_verified_citations() CASCADE;
DROP TABLE IF EXISTS wiki.node_revision, wiki.program_embedding, wiki.program_season_spec, wiki.program,
  wiki.university_housing, wiki.university, wiki.origin_equivalency_rule, wiki.city_profile, wiki.destination_country_rule CASCADE;
