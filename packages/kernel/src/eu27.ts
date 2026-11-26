/** ISO 3166-1 alpha-2 codes of the 27 EU member states (Greece is `GR` in ISO 3166, `EL` in EU usage). */
export const EU27_ISO2 = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
] as const;

export type Eu27Iso2 = (typeof EU27_ISO2)[number];

const EU27_SET: ReadonlySet<string> = new Set(EU27_ISO2);

export function isEu27(iso2: string): iso2 is Eu27Iso2 {
  return EU27_SET.has(iso2);
}
