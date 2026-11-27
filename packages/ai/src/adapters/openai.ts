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
    this.piiApproved = options.piiApproved;
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
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
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
