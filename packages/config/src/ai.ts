import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { ConfigError } from './env.js';

/**
 * Model-router configuration (ENG-T2 §3.4). `AI_MODE=replay` is the default and needs ZERO keys: every call
 * is served from committed cassettes. `AI_MODE=live` reads provider keys through SecretsPort
 * (`openai_api_key`, `gemini_api_key`), never from the environment.
 */
const AbsolutePath = z.string().refine((p) => isAbsolute(p), { message: 'must be an absolute path' });

const AiEnv = z.discriminatedUnion('AI_MODE', [
  z.object({
    AI_MODE: z.literal('replay'),
    AI_CASSETTE_DIR: AbsolutePath,
  }),
  z.object({
    AI_MODE: z.literal('live'),
    OPENAI_BASE_URL: z.url({ protocol: /^https$/ }).optional(),
    /**
     * MEDIUM-6: approval for APPLICANT_PII is bound to an endpoint, not a boolean. Comma-separated hostnames of
     * EU data-zone endpoints (e.g. `eu.api.openai.com`, an Azure OpenAI EU resource); applicant data goes to
     * OpenAI only when OPENAI_BASE_URL points at one of them. Default: none (denied).
     */
    OPENAI_PII_EU_HOSTS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .filter((h) => h !== ''),
      ),
    GEMINI_MODE: z.enum(['direct', 'vertex']).default('direct'),
    VERTEX_PROJECT: z.string().min(1).optional(),
    VERTEX_LOCATION: z
      .string()
      .regex(/^[a-z]+-[a-z]+\d+$/)
      .default('europe-west3'),
  }),
]);

export type AiConfig =
  | { readonly mode: 'replay'; readonly cassetteDir: string }
  | {
      readonly mode: 'live';
      readonly openai: { readonly baseURL: string | undefined; readonly piiApproved: boolean };
      readonly gemini:
        | { readonly mode: 'direct' }
        | { readonly mode: 'vertex'; readonly project: string; readonly location: string };
    };

/** Hostnames of the default (US) OpenAI API: never approved for applicant data. */
const US_OPENAI_HOSTS: ReadonlySet<string> = new Set(['api.openai.com']);

export function loadAiConfig(env: Readonly<Record<string, string | undefined>>): AiConfig {
  const parsed = AiEnv.safeParse({ AI_MODE: 'replay', ...stripEmpty(env) });
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || 'AI_MODE'}: ${i.message}`));
  }
  const e = parsed.data;
  if (e.AI_MODE === 'replay') return { mode: 'replay', cassetteDir: e.AI_CASSETTE_DIR };
  if (e.GEMINI_MODE === 'vertex' && e.VERTEX_PROJECT === undefined) {
    throw new ConfigError(['VERTEX_PROJECT: required when GEMINI_MODE=vertex']);
  }
  if (e.OPENAI_PII_EU_HOSTS.some((h) => US_OPENAI_HOSTS.has(h))) {
    throw new ConfigError([
      'OPENAI_PII_EU_HOSTS: the default (US) OpenAI endpoint can never carry applicant data',
    ]);
  }
  const baseHost =
    e.OPENAI_BASE_URL === undefined ? undefined : new URL(e.OPENAI_BASE_URL).hostname.toLowerCase();
  return {
    mode: 'live',
    openai: {
      baseURL: e.OPENAI_BASE_URL,
      piiApproved: baseHost !== undefined && e.OPENAI_PII_EU_HOSTS.includes(baseHost),
    },
    gemini:
      e.GEMINI_MODE === 'vertex' && e.VERTEX_PROJECT !== undefined
        ? { mode: 'vertex', project: e.VERTEX_PROJECT, location: e.VERTEX_LOCATION }
        : { mode: 'direct' },
  };
}

function stripEmpty(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== '') out[k] = v;
  return out;
}
