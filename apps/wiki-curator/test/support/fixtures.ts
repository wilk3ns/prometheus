import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AllowlistEntry } from '@prometheus/contracts';

const PUBLIC = fileURLToPath(new URL('../../../../deploy/compose/fixture-sites/public/', import.meta.url));

export function fixtureFile(path: string): Buffer {
  return readFileSync(PUBLIC + path);
}

export const fixtureAllowlistEntry = (
  host: string,
  overrides: Partial<AllowlistEntry> = {},
): AllowlistEntry => ({
  host,
  country_iso2: 'PL',
  org_kind: 'UNIVERSITY',
  allow_subdomains: true,
  default_fetch_mode: 'HTTP_FIRST',
  ...overrides,
});
