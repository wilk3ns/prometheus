import { GoogleGenAI } from '@google/genai';
import {
  isAbort,
  type EmbedResponse,
  type GenerateRequest,
  type GenerateResponse,
  type ModelAdapterPort,
} from './types.js';

/**
 * Google Gemini adapter (`AI_MODE=live` only), the only file that may import `@google/genai`.
 * Two endpoint modes (ENG-01 §1): direct Gemini API (allowed for OFFICIAL_SOURCE_ONLY wiki routes only) or
 * Vertex AI in an EU region (approved for APPLICANT_PII). JSON output via `responseJsonSchema`.
 * T2 passes PDFs as `[PAGE N]` text from the snapshot store, not as native PDF parts.
 */
/** The usage fields Gemini bills (subset of `GenerateContentResponseUsageMetadata`). */
export interface GeminiUsage {
  readonly promptTokenCount?: number | undefined;
  readonly candidatesTokenCount?: number | undefined;
  readonly thoughtsTokenCount?: number | undefined;
  readonly toolUsePromptTokenCount?: number | undefined;
}

/**
 * HIGH-3 metering: Gemini 2.5 "thinking" tokens are reported apart from the candidates and billed at the OUTPUT
 * rate; tool-use prompt tokens are billed as input. Both are metered so ledger and budget settle the real spend.
 */
export function meterGemini(usage: GeminiUsage | undefined): { inputTokens: number; outputTokens: number } {
  return {
    inputTokens: (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0),
    outputTokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
  };
}

export type GeminiAdapterOptions =
  | { readonly mode: 'direct'; readonly apiKey: string }
  | { readonly mode: 'vertex'; readonly project: string; readonly location: string };

export class GeminiAdapter implements ModelAdapterPort {
  readonly provider: string;
  readonly ledgerFamily = 'google-gemini' as const;
  readonly piiApproved: boolean;
  private readonly client: GoogleGenAI;

  constructor(options: GeminiAdapterOptions) {
    if (options.mode === 'direct') {
      this.client = new GoogleGenAI({ apiKey: options.apiKey });
      this.provider = 'google-genai';
      this.piiApproved = false;
    } else {
      this.client = new GoogleGenAI({ vertexai: true, project: options.project, location: options.location });
      this.provider = 'google-vertex';
      this.piiApproved = options.location.startsWith('europe-');
    }
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    try {
      const response = await this.client.models.generateContent({
        model: request.model,
        contents: request.user,
        config: {
          systemInstruction: request.system,
          responseMimeType: 'application/json',
          responseJsonSchema: request.jsonSchema,
          maxOutputTokens: request.maxOutputTokens,
          abortSignal: request.signal,
        },
      });
      const text = response.text;
      if (text === undefined || text.trim() === '') {
        const reason = response.candidates?.[0]?.finishReason ?? 'NO_CANDIDATE';
        return { kind: 'REFUSED', detail: `no text (finishReason ${reason})` };
      }
      return {
        kind: 'OK',
        text,
        ...meterGemini(response.usageMetadata),
      };
    } catch (error) {
      if (isAbort(error)) return { kind: 'TIMEOUT', detail: 'deadline exceeded' };
      return {
        kind: 'ERROR',
        detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    }
  }

  embed(): Promise<EmbedResponse> {
    // The catalog serves embeddings from the `emb` tier (OpenAI); Gemini embeddings are not routed in T2.
    return Promise.resolve({ kind: 'ERROR', detail: 'embeddings are not served by the Gemini adapter' });
  }
}
