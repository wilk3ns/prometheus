import type { PromptMeta } from '../prompt-meta.js';

/** Hash lock over system.md + user.tmpl (see registry.ts). Bump `version` with every content change. */
export const meta: PromptMeta = {
  id: 'wiki.deep_extract',
  version: '1.1.0',
  sha256: '73194a64dfe99a2507a4216811b256083dd0f4cc26256675ede63957bf13ce13',
};
