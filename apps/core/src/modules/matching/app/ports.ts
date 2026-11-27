import type { MatchCatalog } from '../domain/catalog.js';

/** Ports of the matching module (implemented in ../infra over the app_core connection). */

export interface MatchCatalogPort {
  /** Matchable specs of `season` (+ origin rules), optionally restricted to destination countries. */
  load(season: string, countries: readonly string[]): Promise<MatchCatalog>;
}

export interface SimilarityScore {
  /** 0..1 */
  readonly score: number;
  readonly method: 'PGVECTOR' | 'PG_TRGM';
}

export interface SimilarityPort {
  /** L2 field similarity per program: pgvector cosine when both vectors exist, pg_trgm otherwise. */
  score(
    programIds: readonly string[],
    query: string,
    queryEmbedding: readonly number[] | null,
  ): Promise<Map<string, SimilarityScore>>;
}

export interface QueryEmbedderPort {
  embed(
    text: string,
    idempotencyKey: string,
  ): Promise<{ readonly embedding: readonly number[] | null; readonly costUsd: number }>;
}

export interface TriageProgram {
  readonly programId: string;
  readonly name: string;
  readonly universityId: string;
  readonly countryIso2: string;
}

export interface TriagePort {
  /** Soft boosts (0..10) by program id (`null` when L3 is unavailable) + metered cost. Output is untrusted. */
  triage(
    programs: readonly TriageProgram[],
    preferences: readonly string[],
    idempotencyKey: string,
  ): Promise<{ readonly boosts: Map<string, number> | null; readonly costUsd: number }>;
}

export interface ProgramListing {
  readonly id: string;
  readonly name_en: string;
  readonly degree_level: string;
  readonly country_iso2: string;
  readonly tuition_annual_eur: number;
  readonly verification_depth: string;
}

export interface ProgramListingPort {
  /** Matchable programs of a season (read-only dev/test listing). */
  listMatchable(season: string, country: string | undefined): Promise<ProgramListing[]>;
}
