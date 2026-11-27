import type { PromptMeta } from '../prompt-meta.js';

/** Hash lock over system.md + user.tmpl (see registry.ts). Bump `version` with every content change. */
export const meta: PromptMeta = {
  id: 'wiki.deep_verify',
  version: '1.0.0',
  sha256: '205d8a3ee45c8b8e10373d3728b9320b560166584e1c3e293ef596a1d5d062a4',
};
