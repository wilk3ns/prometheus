import type { PromptMeta } from '../prompt-meta.js';

/** Hash lock over system.md + user.tmpl (see registry.ts). Bump `version` with every content change. */
export const meta: PromptMeta = {
  id: 'wiki.link_healer',
  version: '1.0.0',
  sha256: 'ed9b87eb194072589c5ba5d5de168f76618214cbcce9d8787f46a31bf85dc5af',
};
