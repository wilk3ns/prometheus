import OpenAI from 'openai';
import {
  isAbort,
  type EmbedRequest,
  type EmbedResponse,
  type GenerateRequest,
  type GenerateResponse,
  type ModelAdapterPort,
} from './types.js';

/**
 * OpenAI adapter (`AI_MODE=live` only): Responses API with a JSON-Schema text format, and embeddings.
 * The only file that may import the `openai` SDK. Output text is returned raw; the router Zod-parses it.
 * SDK-level retries are disabled: the router owns retries, failover and budget.
 */
/** The usage fields the Responses API bills. */
export interface OpenAiUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly output_tokens_details?: { readonly reasoning_tokens?: number } | undefined;
}

/**
 * HIGH-3 metering: on the Responses API `output_tokens` already INCLUDES reasoning tokens
 * (`output_tokens_details.reasoning_tokens` is a breakdown of it). Guarded so a provider-side change that
 * reports reasoning outside `output_tokens` can never make the meter read less than the reasoning count.
 */
export function meterOpenAi(usage: OpenAiUsage | undefined): { inputTokens: number; outputTokens: number } {
  const reasoning = usage?.output_tokens_details?.reasoning_tokens ?? 0;
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: Math.max(usage?.output_tokens ?? 0, reasoning),
  };
}

export interface OpenAiAdapterOptions {
  readonly apiKey: string;
  /** Azure OpenAI / EU data-zone base URL; `undefined` = api.openai.com. */
  readonly baseURL?: string;
  /** True only for an endpoint approved for applicant data (EU data zone). */
  readonly piiApproved: boolean;
}

export class OpenAiAdapter implements ModelAdapterPort {
  readonly provider: string;
  readonly ledgerFamily = 'openai-gpt' as const;
  readonly piiApproved: boolean;
  private readonly client: OpenAI;

  constructor(options: OpenAiAdapterOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      maxRetries: 0,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    });
    this.provider = options.baseURL === undefined ? 'openai' : 'openai-compatible-eu';
    // MEDIUM-6: the default (US) endpoint can never carry applicant data, whatever the option says
    this.piiApproved = options.baseURL !== undefined && options.piiApproved;
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    try {
      const response = await this.client.responses.create(
        {
          model: request.model,
          instructions: request.system,
          input: request.user,
          max_output_tokens: request.maxOutputTokens,
          store: false,
          text: {
            format: {
              type: 'json_schema',
              name: request.schemaName,
              schema: request.jsonSchema,
              strict: false,
            },
          },
        },
        { signal: request.signal },
      );
      const text = response.output_text;
      if (text.trim() === '')
        return { kind: 'REFUSED', detail: `empty output (status ${response.status ?? '?'})` };
      return {
        kind: 'OK',
        text,
        ...meterOpenAi(response.usage),
      };
    } catch (error) {
      if (isAbort(error)) return { kind: 'TIMEOUT', detail: 'deadline exceeded' };
      return {
        kind: 'ERROR',
        detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    }
  }

  async embed(request: EmbedRequest): Promise<EmbedResponse> {
    try {
      const response = await this.client.embeddings.create(
        { model: request.model, input: request.input, dimensions: request.dimensions },
        { signal: request.signal },
      );
      const embedding = response.data[0]?.embedding;
      if (embedding === undefined) return { kind: 'ERROR', detail: 'no embedding returned' };
      return { kind: 'OK', embedding, inputTokens: response.usage.prompt_tokens };
    } catch (error) {
      if (isAbort(error)) return { kind: 'TIMEOUT', detail: 'deadline exceeded' };
      return {
        kind: 'ERROR',
        detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      };
    }
  }
}
