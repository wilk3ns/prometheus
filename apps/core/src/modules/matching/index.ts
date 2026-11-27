/**
 * Public API of the `matching` module (ENG-01 §1: modules talk only through `modules/<m>/index.ts`).
 * Infra adapters are exported for the composition root only.
 */
export {
  MatchService,
  applyTriageBoosts,
  type MatchServiceDeps,
  type MatchOptions,
} from './app/match-service.js';
export type {
  MatchCatalogPort,
  SimilarityPort,
  QueryEmbedderPort,
  TriagePort,
  ProgramListing,
  ProgramListingPort,
} from './app/ports.js';
export {
  evaluateL1,
  defaultSeasonStart,
  isMinorOnDate,
  type L1Result,
  type L1Match,
} from './domain/l1-rules.js';
export type { MatchCatalog, ProgramCandidate, OriginRuleView } from './domain/catalog.js';
export { KyselyMatchCatalog, SqlSimilarity } from './infra/kysely-match-catalog.js';
export { RouterTriage, RouterQueryEmbedder } from './infra/router-adapters.js';
