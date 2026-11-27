import type { ModelFamily } from '@prometheus/contracts';
import type { SecretsPort } from '@prometheus/infra-ports';
import { CassetteStore, ReplayAdapter } from './adapters/replay.js';
import type { ModelAdapterPort } from './adapters/types.js';

/** Adapter selection by AI mode (the composition roots call this; nothing else picks adapters). */
export type AdapterMode =
  | { readonly mode: 'replay'; readonly cassetteDir: string }
  | {
      readonly mode: 'live';
      readonly openai: { readonly baseURL: string | undefined; readonly piiApproved: boolean };
      readonly gemini:
        | { readonly mode: 'direct' }
        | { readonly mode: 'vertex'; readonly project: string; readonly location: string };
    };

export async function buildAdapters(
  mode: AdapterMode,
  secrets: SecretsPort,
): Promise<Readonly<Record<ModelFamily, ModelAdapterPort>>> {
  if (mode.mode === 'replay') {
    const replay = new ReplayAdapter(CassetteStore.fromDirectory(mode.cassetteDir));
    return { 'openai-gpt': replay, 'google-gemini': replay };
  }
  // Vendor SDKs load only in live mode (replay processes never import them).
  const [{ OpenAiAdapter }, { GeminiAdapter }] = await Promise.all([
    import('./adapters/openai.js'),
    import('./adapters/gemini.js'),
  ]);
  const openai = new OpenAiAdapter({
    apiKey: await secrets.getSecret('openai_api_key'),
    piiApproved: mode.openai.piiApproved,
    ...(mode.openai.baseURL === undefined ? {} : { baseURL: mode.openai.baseURL }),
  });
  const gemini =
    mode.gemini.mode === 'direct'
      ? new GeminiAdapter({ mode: 'direct', apiKey: await secrets.getSecret('gemini_api_key') })
      : new GeminiAdapter({ mode: 'vertex', project: mode.gemini.project, location: mode.gemini.location });
  return { 'openai-gpt': openai, 'google-gemini': gemini };
}
