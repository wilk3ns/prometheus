/** Ephemeral cache (Valkey). Nothing stored here is authoritative; callers must tolerate misses. */
export interface CachePort {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  close(): Promise<void>;
}
