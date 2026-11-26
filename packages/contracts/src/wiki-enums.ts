import { z } from 'zod';

/** Destination countries covered by the Wiki (mirrors the CHECK constraints in the T1 migration). */
export const DestinationCountry = z.enum(['IT', 'DE', 'PL', 'HU', 'TR']);
export type DestinationCountry = z.infer<typeof DestinationCountry>;

export const OrgKind = z.enum([
  'UNIVERSITY',
  'MINISTRY_PORTAL',
  'RECOGNITION_BODY',
  'CITY_TRANSIT',
  'SCHOLARSHIP_BODY',
  'HOUSING',
]);
export type OrgKind = z.infer<typeof OrgKind>;

export const FetchMode = z.enum(['HTTP_FIRST', 'JS_CATALOG']);
export type FetchMode = z.infer<typeof FetchMode>;

export const LayerHint = z.enum([
  'COUNTRY',
  'CITY',
  'ORIGIN_EQUIVALENCY',
  'UNIVERSITY',
  'HOUSING',
  'PROGRAM',
]);
export type LayerHint = z.infer<typeof LayerHint>;

export const FetchTier = z.enum(['TIER1_HTTP', 'TIER2_PLAYWRIGHT']);
export type FetchTier = z.infer<typeof FetchTier>;

export const ContentKind = z.enum(['HTML', 'PDF', 'HTTP_ERROR']);
export type ContentKind = z.infer<typeof ContentKind>;
