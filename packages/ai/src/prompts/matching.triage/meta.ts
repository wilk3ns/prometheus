import type { PromptMeta } from '../prompt-meta.js';

/** Hash lock over system.md + user.tmpl (see registry.ts). Bump `version` with every content change. */
export const meta: PromptMeta = {
  id: 'matching.triage',
  version: '1.0.0',
  sha256: '85b67facfc4a7153cf0da7a433141de2e355ae130cce09d70d599274d0081d63',
};
