import type { PromptMeta } from '../prompt-meta.js';

/** Hash lock over system.md + user.tmpl (see registry.ts). Bump `version` with every content change. */
export const meta: PromptMeta = {
  id: 'wiki.baseline_extract',
  version: '1.0.0',
  sha256: 'a3f46e36723c9391f9aa0c9ba63c0ec69832f9f065d3401657bd9089d5347a8a',
};
