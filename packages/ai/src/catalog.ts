import type { ModelFamily, ModelTier } from '@prometheus/contracts';

/**
 * Model tiers (ENG-T2 §1 catalog.ts). Callers name a tier, never a vendor model id, so a model swap is a
 * one-line catalog change. Prices drive the worst-case budget reservation and the ledger cost estimate;
 * they are mirrored into `econ.rate_card` at bootstrap so every ledger row is auditable against them.
 * [ASSUMPTION] list prices (USD per 1M tokens) as published by the vendors for these model ids.
 */
export interface TierSpec {
  readonly tier: ModelTier;
  readonly family: ModelFamily;
  readonly model: string;
  readonly kind: 'GENERATE' | 'EMBED';
  readonly inputUsdPer1M: number;
  readonly outputUsdPer1M: number;
}

export const CATALOG: Readonly<Record<ModelTier, TierSpec>> = {
  'gg.lite': {
    tier: 'gg.lite',
    family: 'google-gemini',
    model: 'gemini-2.5-flash-lite',
    kind: 'GENERATE',
    inputUsdPer1M: 0.1,
    outputUsdPer1M: 0.4,
  },
  'gg.flash': {
    tier: 'gg.flash',
    family: 'google-gemini',
    model: 'gemini-2.5-flash',
    kind: 'GENERATE',
    inputUsdPer1M: 0.3,
    outputUsdPer1M: 2.5,
  },
  'gg.pro': {
    tier: 'gg.pro',
    family: 'google-gemini',
    model: 'gemini-2.5-pro',
    kind: 'GENERATE',
    inputUsdPer1M: 1.25,
    outputUsdPer1M: 10,
  },
  'oa.mini': {
    tier: 'oa.mini',
    family: 'openai-gpt',
    model: 'gpt-5-mini',
    kind: 'GENERATE',
    inputUsdPer1M: 0.25,
    outputUsdPer1M: 2,
  },
  'oa.flagship': {
    tier: 'oa.flagship',
    family: 'openai-gpt',
    model: 'gpt-5',
    kind: 'GENERATE',
    inputUsdPer1M: 1.25,
    outputUsdPer1M: 10,
  },
  emb: {
    tier: 'emb',
    family: 'openai-gpt',
    model: 'text-embedding-3-small',
    kind: 'EMBED',
    inputUsdPer1M: 0.02,
    outputUsdPer1M: 0,
  },
};

/** Embedding width of `wiki.program_embedding.embedding vector(1536)`. */
export const EMBEDDING_DIMENSIONS = 1536;

/** USD for a token count at a tier, rounded up to the 6-decimal precision of the econ columns. */
export function costUsd(spec: TierSpec, inputTokens: number, outputTokens: number): number {
  const raw = (inputTokens * spec.inputUsdPer1M + outputTokens * spec.outputUsdPer1M) / 1_000_000;
  return Math.ceil(raw * 1_000_000) / 1_000_000;
}

/**
 * Conservative token estimate for budget reservation (3 chars/token; real tokenisers average ~4 for
 * English and less for az/ru/pl, so the reservation over-estimates rather than under-estimates).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}
