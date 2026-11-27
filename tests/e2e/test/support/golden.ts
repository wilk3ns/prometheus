import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  ApplicantMatchInput,
  CityProfileFields,
  OriginEquivalencyFields,
  ProgramSpecNodeFields,
  UniversityFields,
  type MatchResult,
} from '@prometheus/contracts';
import type { GoldenPlan } from '../../../../apps/wiki-curator/src/curator/golden-mapping.js';
import type {
  MatchCatalog,
  OriginRuleView,
  ProgramCandidate,
} from '../../../../apps/core/src/modules/matching/index.js';

/**
 * Shared support for the golden-record gates (6, 7, 9). Golden fixtures are product knowledge and live ONLY in
 * the vault: `PROMETHEUS_VAULT_DIR` must point at it (nothing is copied into the repo).
 */

export const GOLDEN_FILES = ['golden-polimi-msc-cse-2027.json', 'golden-wut-bsc-cs-2027.json'] as const;

export function goldenPath(file: (typeof GOLDEN_FILES)[number]): string {
  const vault = process.env['PROMETHEUS_VAULT_DIR'];
  if (vault === undefined || !isAbsolute(vault)) {
    throw new Error(
      'PROMETHEUS_VAULT_DIR (absolute path to the prometheus vault) is required for golden-record tests',
    );
  }
  return join(vault, 'engineering', 'fixtures', file);
}

const Profiles = z.strictObject({
  schema: z.literal('gate7-profiles-v1'),
  source: z.string(),
  profiles: z.array(
    z.strictObject({
      id: z.enum(['P1', 'P2', 'P3']),
      label: z.string(),
      asOf: z.iso.datetime(),
      input: ApplicantMatchInput,
    }),
  ),
});
export type Gate7Profile = z.infer<typeof Profiles>['profiles'][number];

export function loadGate7Profiles(): Gate7Profile[] {
  const file = fileURLToPath(new URL('../../fixtures/gate7-profiles.json', import.meta.url));
  return Profiles.parse(JSON.parse(readFileSync(file, 'utf8'))).profiles;
}

/**
 * In-memory read model from mapped golden plans (exactly the columns the importer writes), for evaluating the
 * pure L1 engine on the real golden data without a database.
 */
export function catalogFromPlans(plans: readonly GoldenPlan[]): MatchCatalog {
  const nodes = plans.flatMap((p) => p.nodes);
  const universities = new Map(
    nodes.filter((n) => n.layer === 'UNIVERSITY').map((n) => [n.nodeKey, UniversityFields.parse(n.fields)]),
  );
  const cities = new Map(
    nodes.filter((n) => n.layer === 'CITY').map((n) => [n.nodeKey, CityProfileFields.parse(n.fields)]),
  );
  const housing = nodes.filter((n) => n.layer === 'HOUSING');
  const candidates = nodes
    .filter((n) => n.layer === 'PROGRAM_SPEC')
    .map((n, i): ProgramCandidate => {
      const { program, ...spec } = ProgramSpecNodeFields.omit({ program_requirements_json: true }).parse(
        Object.fromEntries(Object.entries(n.fields).filter(([k]) => k !== 'program_requirements_json')),
      );
      const uni = universities.get(program.university_id);
      if (uni === undefined) throw new Error(`no university ${program.university_id}`);
      const city = cities.get(uni.city_id);
      const dorm = housing.find((h) => h.nodeKey.startsWith(`${uni.id}:`));
      const dormMin = dorm === undefined ? null : z.number().nullable().parse(dorm.fields['monthly_min_eur']);
      if (n.wikiStatus === null) throw new Error(`${n.nodeKey} has no wiki status`);
      return {
        specId: `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`,
        depth: n.depth,
        wikiStatus: n.wikiStatus,
        program,
        spec,
        university: {
          id: uni.id,
          countryIso2: uni.country_iso2,
          creditCardAccepted: uni.credit_card_accepted,
          minorConsents: uni.minor_consents_json,
        },
        city:
          city === undefined
            ? null
            : { monthlyLivingMinEur: city.monthly_living_min_eur, minorConsents: city.minor_consents_json },
        housing: { monthlyMinEur: dormMin },
      };
    });
  const originRules = nodes
    .filter((n) => n.layer === 'ORIGIN_EQUIVALENCY')
    .map((n): OriginRuleView => {
      const o = OriginEquivalencyFields.parse(n.fields);
      return {
        destinationCountryIso2: o.destination_country_iso2,
        citizenshipCountry: o.citizenship_country,
        diplomaOriginCountry: o.diploma_origin_country,
        diplomaType: o.diploma_type,
        admissionSeason: o.admission_season,
        equivalencyPolicy: o.equivalency_policy,
        nationalRecognitionLeadDays: o.national_recognition_lead_days,
        ruSectorTranslationExempt: o.ru_sector_translation_exempt,
        minorConsents: o.minor_consents_json,
        depth: n.depth,
      };
    });
  return { candidates, originRules };
}

/** Minimal view of a match result (structural: works for L1 output and the HTTP MatchResult alike). */
export interface Matches {
  readonly matches: ReadonlyArray<Pick<MatchResult['matches'][number], 'programId' | 'fitTier' | 'flags'>>;
  readonly excluded: MatchResult['excluded'];
}

const flagsOf = (r: Matches, programId: string) =>
  r.matches.find((m) => m.programId === programId)?.flags ?? [];

/** ENG-T2 §6 Gate 7 expectations per profile; returns the list of violations (empty = pass). */
export function gate7Violations(profile: 'P1' | 'P2' | 'P3', r: Matches): string[] {
  const v: string[] = [];
  const need = (ok: boolean, what: string) => {
    if (!ok) v.push(`${profile}: ${what}`);
  };
  const match = (id: string) => r.matches.find((m) => m.programId === id);
  const has = (id: string, code: string) => flagsOf(r, id).some((f) => f.code === code);
  if (profile === 'P1') {
    const m = match('polimi:msc-cse');
    need(m !== undefined, 'polimi:msc-cse is matched');
    need(m?.fitTier === 'CONDITIONAL', `polimi:msc-cse is CONDITIONAL (got ${m?.fitTier ?? 'none'})`);
    need(
      flagsOf(r, 'polimi:msc-cse').some(
        (f) => f.code === 'SCHOLARSHIP_DEPENDENT' && f.refs.includes('DSU_LOMBARDIA'),
      ),
      'SCHOLARSHIP_DEPENDENT (DSU_LOMBARDIA)',
    );
    need(has('polimi:msc-cse', 'EXEMPT_VIA_EMI'), 'EXEMPT_VIA_EMI');
  }
  if (profile === 'P2') {
    need(
      r.excluded.some((e) => e.programId === 'wut:bsc-cs-networks' && e.reasons.includes('OVER_BUDGET')),
      'wut:bsc-cs-networks excluded OVER_BUDGET (EUR 11,040 > EUR 5,000, no B.Sc. scholarships)',
    );
    need(match('wut:bsc-power-eng') !== undefined, 'wut:bsc-power-eng (EUR 4,680) is matched');
    need(
      has('wut:bsc-power-eng', 'CALENDAR_CRUNCH_WARNING'),
      'CALENDAR_CRUNCH_WARNING (June Attestat + 60 d NAWA > mid-August)',
    );
    const minor = flagsOf(r, 'wut:bsc-power-eng').find((f) => f.code === 'MINOR_UNDER_18_CONSENTS');
    need(
      minor !== undefined &&
        ['NAWA_SYRENA_GUARDIAN_DECLARATION', 'WUT_ISO_PARENTAL_CONSENT', 'NFZ_PARENT_CONSENT'].every((c) =>
          minor.refs.includes(c),
        ),
      `MINOR_UNDER_18_CONSENTS with all 3 Polish consents (got ${minor?.refs.join(',') ?? 'none'})`,
    );
    need(has('wut:bsc-power-eng', 'RU_SECTOR_TRANSLATION_EXEMPT'), 'RU_SECTOR_TRANSLATION_EXEMPT');
    need(has('wut:bsc-power-eng', 'BANK_TRANSFER_ONLY'), 'BANK_TRANSFER_ONLY');
  }
  if (profile === 'P3') {
    const m = match('wut:bsc-cs-networks');
    need(m?.fitTier === 'CONDITIONAL', `wut:bsc-cs-networks is CONDITIONAL (got ${m?.fitTier ?? 'none'})`);
    need(has('wut:bsc-cs-networks', 'MISSING_ENGLISH_B2_CERT'), 'MISSING_ENGLISH_B2_CERT');
    need(has('wut:bsc-cs-networks', 'CALENDAR_CRUNCH_WARNING'), 'CALENDAR_CRUNCH_WARNING');
    need(has('wut:bsc-cs-networks', 'MINOR_UNDER_18_CONSENTS'), 'MINOR_UNDER_18_CONSENTS');
    need(!has('wut:bsc-cs-networks', 'RU_SECTOR_TRANSLATION_EXEMPT'), 'no RU_SECTOR_TRANSLATION_EXEMPT');
  }
  return v;
}
