/** Identity + content lock of one versioned prompt folder (`system.md` + `user.tmpl`). */
export interface PromptMeta {
  readonly id: string;
  readonly version: string;
  /** sha256 over `system.md` + NUL + `user.tmpl` (see registry.ts `promptContentHash`). */
  readonly sha256: string;
}
