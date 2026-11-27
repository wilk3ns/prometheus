import { z } from 'zod';
import { LAYER_FIELD_SCHEMAS, ProposalCitation, SlotCompleteness, type WikiLayer } from './wiki.js';

/**
 * AI contracts (ENG-T2 §1, §3, §4). Every model output is parsed against one of these schemas; the same Zod
 * schema produces the JSON Schema sent to the provider. A parsed output is still untrusted: deterministic
 * validators and the publish gate decide what is written.
 */

/** Logical model family. `replay` is only ever a physical provider (cassettes), never a logical family. */
export const ModelFamily = z.enum(['openai-gpt', 'google-gemini']);
export type ModelFamily = z.infer<typeof ModelFamily>;

export const ModelTier = z.enum(['gg.lite', 'gg.flash', 'gg.pro', 'oa.mini', 'oa.flagship', 'emb']);
export type ModelTier = z.infer<typeof ModelTier>;

/** What a call may carry. Official web/PDF text only, or applicant data (EU-approved endpoints only). */
export const DataClass = z.enum(['OFFICIAL_SOURCE_ONLY', 'APPLICANT_PII']);
export type DataClass = z.infer<typeof DataClass>;

export const RouteId = z.enum([
  'RTE-wiki.link_healer',
  'RTE-wiki.baseline_extract',
  'RTE-wiki.deep_extract',
  'RTE-wiki.deep_verify',
  'RTE-matching.embed',
  'RTE-matching.triage',
]);
export type RouteId = z.infer<typeof RouteId>;

/** `econ.ai_usage_ledger.outcome` values. */
export const CallOutcome = z.enum([
  'OK',
  'SCHEMA_INVALID',
  'ABSTAIN',
  'BUDGET',
  'DEADLINE',
  'POLICY_DENIED',
  'ERROR',
]);
export type CallOutcome = z.infer<typeof CallOutcome>;

export const AiSubsystem = z.enum([
  'WIKI_BASELINE',
  'WIKI_DEEP_VERIFY',
  'MATCHING',
  'VOICE',
  'DOC_VLM',
  'COUNSELOR',
]);
export type AiSubsystem = z.infer<typeof AiSubsystem>;

/**
 * Agent A output for one node of one layer. `fields` defaults to the full layer schema; callers may pass a
 * narrower proposal schema (e.g. without ops-owned columns a model must never propose).
 */
export function wikiNodeProposalSchema(
  layer: WikiLayer,
  fields: z.ZodType<Record<string, unknown>> = LAYER_FIELD_SCHEMAS[layer],
) {
  return z.strictObject({
    layer: z.literal(layer),
    node_key: z.string().min(1),
    fields,
    slot_completeness: SlotCompleteness,
    abstain_fields: z.array(z.string().min(1)),
    citations: z.array(ProposalCitation),
  });
}

/** Layer-agnostic view of a parsed proposal (fields are re-parsed against the layer schema before commit). */
export interface WikiNodeProposal {
  readonly layer: WikiLayer;
  readonly node_key: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly slot_completeness: z.infer<typeof SlotCompleteness>;
  readonly abstain_fields: readonly string[];
  readonly citations: ReadonlyArray<z.infer<typeof ProposalCitation>>;
}

export const Discrepancy = z.strictObject({
  field_path: z.string().min(1),
  kind: z.enum(['VALUE_MISMATCH', 'EU_VS_NONEU', 'STALE_SEASON', 'UNSUPPORTED_BY_SOURCE', 'OTHER']),
  detail: z.string().min(1).max(2_000),
});
export type Discrepancy = z.infer<typeof Discrepancy>;

/** Agent B output: an independent audit of Agent A's proposal against the raw sources. */
export const VerificationReport = z.strictObject({
  verification_score: z.number().min(0).max(1),
  checked_paths: z.array(z.string().min(1)),
  discrepancies: z.array(Discrepancy),
});
export type VerificationReport = z.infer<typeof VerificationReport>;

/** RTE-wiki.link_healer: the model may only pick one of the offered candidates (or none). */
export const LinkHealerResult = z.strictObject({
  chosen_url: z.string().nullable(),
  rationale: z.string().max(500),
});
export type LinkHealerResult = z.infer<typeof LinkHealerResult>;

/** RTE-matching.triage: soft boosts only (0..10); the router's caller enforces the L1-subset post-condition. */
export const TriageResult = z.strictObject({
  boosts: z.array(
    z.strictObject({
      program_id: z.string().min(1),
      boost: z.number().min(0).max(10),
      rationale: z.string().max(300),
    }),
  ),
});
export type TriageResult = z.infer<typeof TriageResult>;
