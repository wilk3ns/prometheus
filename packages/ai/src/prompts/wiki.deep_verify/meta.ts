import type { PromptMeta } from '../prompt-meta.js';

/** Hash lock over system.md + user.tmpl (see registry.ts). Bump `version` with every content change. */
export const meta: PromptMeta = {
  id: 'wiki.deep_verify',
  version: '1.1.0',
  sha256: '192e93c82259d2fd901a58620b364ea389b8b194f4fcf131affdbf2d2ca42ea6',
};
