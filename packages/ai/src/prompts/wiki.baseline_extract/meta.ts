import type { PromptMeta } from '../prompt-meta.js';

/** Hash lock over system.md + user.tmpl (see registry.ts). Bump `version` with every content change. */
export const meta: PromptMeta = {
  id: 'wiki.baseline_extract',
  version: '1.1.0',
  sha256: 'adf3a7fcde67f0a60628a4b3f008082aa6f236b8ef709a6bebbb7114aff7ffa1',
};
