-- migrate:up
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wiki_reader') THEN CREATE ROLE wiki_reader NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wiki_writer') THEN CREATE ROLE wiki_writer LOGIN PASSWORD 'dev_wiki_writer'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_core')    THEN CREATE ROLE app_core LOGIN PASSWORD 'dev_app_core'; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS wiki;
GRANT wiki_reader TO app_core;
GRANT USAGE ON SCHEMA wiki TO wiki_reader, wiki_writer;

CREATE TABLE wiki.official_domain_allowlist (
  host              text PRIMARY KEY CHECK (host = lower(host) AND host NOT LIKE 'http%'),
  country_iso2      char(2) NOT NULL CHECK (country_iso2 IN ('IT','DE','PL','HU','TR')),
  org_kind          text NOT NULL CHECK (org_kind IN ('UNIVERSITY','MINISTRY_PORTAL','RECOGNITION_BODY','CITY_TRANSIT','SCHOLARSHIP_BODY','HOUSING')),
  allow_subdomains  boolean NOT NULL DEFAULT true,
  default_fetch_mode text NOT NULL DEFAULT 'HTTP_FIRST' CHECK (default_fetch_mode IN ('HTTP_FIRST','JS_CATALOG')),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wiki.crawl_target (
  id                uuid PRIMARY KEY,
  target_key        text NOT NULL UNIQUE, -- e.g. 'polimi:msc-cse:2027-FALL'
  country_iso2      char(2) NOT NULL CHECK (country_iso2 IN ('IT','DE','PL','HU','TR')),
  layer_hint        text NOT NULL CHECK (layer_hint IN ('COUNTRY','CITY','ORIGIN_EQUIVALENCY','UNIVERSITY','HOUSING','PROGRAM')),
  seed_urls_json    jsonb NOT NULL CHECK (jsonb_typeof(seed_urls_json) = 'array'),
  max_depth         smallint NOT NULL DEFAULT 2 CHECK (max_depth BETWEEN 0 AND 3),
  max_pages         smallint NOT NULL DEFAULT 30 CHECK (max_pages BETWEEN 1 AND 100),
  active            boolean NOT NULL DEFAULT true,
  last_crawled_at   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wiki.source_snapshot (
  id                uuid PRIMARY KEY,
  target_id         uuid REFERENCES wiki.crawl_target(id) ON DELETE SET NULL,
  requested_url     text NOT NULL,
  final_url         text NOT NULL,
  host              text NOT NULL,
  http_status       smallint NOT NULL,
  fetch_tier        text NOT NULL CHECK (fetch_tier IN ('TIER1_HTTP','TIER2_PLAYWRIGHT')),
  content_kind      text NOT NULL CHECK (content_kind IN ('HTML','PDF','HTTP_ERROR')),
  detected_lang     varchar(8),
  raw_sha256        char(64),             -- NULL only when http_status >= 400 and no body stored
  raw_blob_ref      text,                 -- wiki-snapshots/raw/<sha256>.(html|pdf)
  clean_text_sha256 char(64),
  clean_text_blob_ref text,               -- wiki-snapshots/text/<sha256>.txt
  clean_char_count  integer NOT NULL DEFAULT 0 CHECK (clean_char_count >= 0),
  page_count        smallint,             -- populated for PDFs
  discovered_links_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_code        text,                 -- e.g. 'MISSING_SOURCE_404', 'DISALLOWED_REDIRECT', 'WAF_CHALLENGE_DETECTED'
  fetched_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_source_snapshot_final_url ON wiki.source_snapshot (final_url, fetched_at DESC);
CREATE INDEX idx_source_snapshot_raw_sha256 ON wiki.source_snapshot (raw_sha256) WHERE raw_sha256 IS NOT NULL;
CREATE INDEX idx_source_snapshot_target ON wiki.source_snapshot (target_id, fetched_at DESC);

-- Strict Single-Writer Role Enforcement (GR-AI-012)
GRANT SELECT ON ALL TABLES IN SCHEMA wiki TO wiki_reader;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA wiki TO wiki_writer;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA wiki FROM app_core, PUBLIC;
REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA wiki FROM wiki_writer;

ALTER DEFAULT PRIVILEGES IN SCHEMA wiki GRANT SELECT ON TABLES TO wiki_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA wiki GRANT SELECT, INSERT, UPDATE ON TABLES TO wiki_writer;

-- migrate:down
DROP SCHEMA IF EXISTS wiki CASCADE;
