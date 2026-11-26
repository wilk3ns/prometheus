import { z } from 'zod';
import { DestinationCountry, FetchMode, LayerHint, OrgKind } from './wiki-enums.js';

/** Bare lower-case DNS hostname (no scheme, port, path or trailing dot). */
export const Hostname = z
  .string()
  .min(1)
  .max(253)
  .regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/, {
    message: 'must be a bare lower-case hostname',
  });

export const HttpUrl = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === ''
      );
    } catch {
      return false;
    }
  },
  { message: 'must be an absolute http(s) URL without credentials' },
);

export const AllowlistEntry = z.strictObject({
  host: Hostname,
  country_iso2: DestinationCountry,
  org_kind: OrgKind,
  allow_subdomains: z.boolean(),
  default_fetch_mode: FetchMode,
  notes: z.string().min(1).optional(),
});
export type AllowlistEntry = z.infer<typeof AllowlistEntry>;

export const SeedCrawlTarget = z.strictObject({
  target_key: z
    .string()
    .regex(/^[a-z0-9-]+(:[A-Za-z0-9.-]+)+$/, { message: "must look like 'org:program:season'" }),
  country_iso2: DestinationCountry,
  layer_hint: LayerHint,
  max_depth: z.int().min(0).max(3),
  max_pages: z.int().min(1).max(100),
  seed_urls: z.array(HttpUrl).min(1),
});
export type SeedCrawlTarget = z.infer<typeof SeedCrawlTarget>;

export const SeedFile = z.strictObject({
  schema_version: z.literal('seed-targets-v1.0'),
  allowlisted_domains: z.array(AllowlistEntry).min(1),
  crawl_targets: z.array(SeedCrawlTarget),
});
export type SeedFile = z.infer<typeof SeedFile>;
