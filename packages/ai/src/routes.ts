import type { AiSubsystem, DataClass, ModelTier, RouteId } from '@prometheus/contracts';

/**
 * Route policy table (ENG-T2 §3). A route fixes what data it may carry, which tiers may serve it (primary,
 * then fallback), its per-call-key USD cap, output bound and deadline. Callers cannot widen any of these.
 */
export interface RouteSpec {
  readonly id: RouteId;
  readonly subsystem: AiSubsystem;
  readonly allowedDataClasses: readonly DataClass[];
  readonly primary: ModelTier;
  readonly fallback: ModelTier | undefined;
  /** Cap on the summed reservations of one `callKey` (`econ.call_budget.cap_usd`). */
  readonly costCapUsd: number;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  /** GR-AI-009: the caller MUST name the family to exclude (Agent B never shares Agent A's family). */
  readonly requiresExcludeFamily: boolean;
  /** Prompt registry id; `undefined` for embedding routes. */
  readonly promptId: string | undefined;
}

export const ROUTES: Readonly<Record<RouteId, RouteSpec>> = {
  'RTE-wiki.link_healer': {
    id: 'RTE-wiki.link_healer',
    subsystem: 'WIKI_BASELINE',
    allowedDataClasses: ['OFFICIAL_SOURCE_ONLY'],
    primary: 'gg.lite',
    fallback: 'oa.mini',
    costCapUsd: 0.01,
    maxOutputTokens: 512,
    timeoutMs: 30_000,
    requiresExcludeFamily: false,
    promptId: 'wiki.link_healer',
  },
  'RTE-wiki.baseline_extract': {
    id: 'RTE-wiki.baseline_extract',
    subsystem: 'WIKI_BASELINE',
    allowedDataClasses: ['OFFICIAL_SOURCE_ONLY'],
    primary: 'gg.flash',
    fallback: 'oa.mini',
    costCapUsd: 0.03,
    maxOutputTokens: 6_000,
    timeoutMs: 120_000,
    requiresExcludeFamily: false,
    promptId: 'wiki.baseline_extract',
  },
  'RTE-wiki.deep_extract': {
    id: 'RTE-wiki.deep_extract',
    subsystem: 'WIKI_DEEP_VERIFY',
    allowedDataClasses: ['OFFICIAL_SOURCE_ONLY'],
    primary: 'gg.pro',
    fallback: 'oa.flagship',
    costCapUsd: 0.5,
    maxOutputTokens: 12_000,
    timeoutMs: 180_000,
    requiresExcludeFamily: false,
    promptId: 'wiki.deep_extract',
  },
  'RTE-wiki.deep_verify': {
    id: 'RTE-wiki.deep_verify',
    subsystem: 'WIKI_DEEP_VERIFY',
    allowedDataClasses: ['OFFICIAL_SOURCE_ONLY'],
    primary: 'oa.flagship',
    fallback: 'gg.pro',
    costCapUsd: 0.5,
    maxOutputTokens: 6_000,
    timeoutMs: 180_000,
    requiresExcludeFamily: true,
    promptId: 'wiki.deep_verify',
  },
  'RTE-matching.embed': {
    id: 'RTE-matching.embed',
    subsystem: 'MATCHING',
    allowedDataClasses: ['OFFICIAL_SOURCE_ONLY', 'APPLICANT_PII'],
    primary: 'emb',
    fallback: undefined,
    costCapUsd: 0.001,
    maxOutputTokens: 0,
    timeoutMs: 15_000,
    requiresExcludeFamily: false,
    promptId: undefined,
  },
  'RTE-matching.triage': {
    id: 'RTE-matching.triage',
    subsystem: 'MATCHING',
    allowedDataClasses: ['APPLICANT_PII'],
    primary: 'oa.mini',
    fallback: 'gg.flash',
    costCapUsd: 0.005,
    maxOutputTokens: 1_500,
    timeoutMs: 20_000,
    requiresExcludeFamily: false,
    promptId: 'matching.triage',
  },
};
