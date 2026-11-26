import type { Kysely, Transaction } from 'kysely';

const SERIALIZATION_FAILURE = '40001';
const DEADLOCK_DETECTED = '40P01';

export interface SerializableOptions {
  /** Total attempts including the first (default 5). */
  readonly maxAttempts?: number;
}

export class SerializableRetriesExhaustedError extends Error {
  override readonly name = 'SerializableRetriesExhaustedError';
}

function isRetryable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = error.code;
  return code === SERIALIZATION_FAILURE || code === DEADLOCK_DETECTED;
}

/**
 * Runs `work` in a SERIALIZABLE transaction, retrying on serialization failure / deadlock.
 * `work` must be free of external side effects because it may execute more than once.
 */
export async function withSerializable<DBT, T>(
  db: Kysely<DBT>,
  work: (trx: Transaction<DBT>) => Promise<T>,
  options: SerializableOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 5;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await db.transaction().setIsolationLevel('serializable').execute(work);
    } catch (error) {
      if (!isRetryable(error)) throw error;
      lastError = error;
    }
  }
  throw new SerializableRetriesExhaustedError(
    `serializable transaction failed after ${maxAttempts} attempts`,
    {
      cause: lastError,
    },
  );
}
