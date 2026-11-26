/** SQLSTATE of a PostgreSQL error raised through `pg`, if any. */
export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

export const PG_INSUFFICIENT_PRIVILEGE = '42501';
