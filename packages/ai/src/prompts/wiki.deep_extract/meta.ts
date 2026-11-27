import type { PromptMeta } from '../prompt-meta.js';

/** Hash lock over system.md + user.tmpl (see registry.ts). Bump `version` with every content change. */
export const meta: PromptMeta = {
  id: 'wiki.deep_extract',
  version: '1.0.0',
  sha256: '0144c340a0f64a0953981fefb2fca79f57ed44d79b59f5d935689ba72ee191ca',
};
