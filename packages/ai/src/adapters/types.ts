import type { ModelFamily, ModelTier, RouteId } from '@prometheus/contracts';

/** The material a replay cassette is keyed by (ENG-T2 §3.4). Live adapters ignore it. */
export interface CassetteKeyMaterial {
  readonly route: RouteId;
  readonly promptHash: string;
  readonly tier: ModelTier;
  readonly excludeFamily: ModelFamily | null;
  readonly inputHash: string;
}

export interface GenerateRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  /** JSON Schema generated from the route's Zod output schema. */
  readonly jsonSchema: Record<string, unknown>;
  readonly schemaName: string;
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
  readonly cassette: CassetteKeyMaterial;
}

export type GenerateResponse =
  | {
      readonly kind: 'OK';
      readonly text: string;
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  /** The model declined (safety refusal / empty candidate). */
  | { readonly kind: 'REFUSED'; readonly detail: string }
  | { readonly kind: 'TIMEOUT'; readonly detail: string }
  | { readonly kind: 'ERROR'; readonly detail: string };

export interface EmbedRequest {
  readonly model: string;
  readonly input: string;
  readonly dimensions: number;
  readonly signal: AbortSignal;
  readonly cassette: CassetteKeyMaterial;
}

export type EmbedResponse =
  | { readonly kind: 'OK'; readonly embedding: readonly number[]; readonly inputTokens: number }
  | { readonly kind: 'TIMEOUT'; readonly detail: string }
  | { readonly kind: 'ERROR'; readonly detail: string };

/** One physical provider endpoint. In replay mode both logical families map to the replay adapter. */
export interface ModelAdapterPort {
  /** `econ.ai_usage_ledger.provider` */
  readonly provider: string;
  /** `econ.ai_usage_ledger.family` (the physical family; `replay` for cassettes). */
  readonly ledgerFamily: ModelFamily | 'replay';
  /** Whether this endpoint may receive APPLICANT_PII (EU-approved endpoint, e.g. Vertex EU). */
  readonly piiApproved: boolean;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
  embed(request: EmbedRequest): Promise<EmbedResponse>;
}

export function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
