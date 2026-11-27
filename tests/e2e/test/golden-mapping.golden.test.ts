import { describe, expect, it } from 'vitest';
import { readGoldenPlan } from '../../../apps/wiki-curator/src/curator/golden-importer.js';
import type { GoldenNode, GoldenPlan } from '../../../apps/wiki-curator/src/curator/golden-mapping.js';
import { LAYERS } from '../../../apps/wiki-curator/src/curator/layers.js';
import { goldenPath } from './support/golden.js';

/**
 * [T2-G6][T2-G7] The single mapping module applied to the REAL vault golden fixtures: every ruled value lands
 * in the right column, and the only unfillable NOT NULL column is reported as a TODO_RULING marker.
 */
describe('[T2-G6][T2-G7] golden fixture mapping (golden-mapping.ts)', async () => {
  const polimi = await readGoldenPlan(goldenPath('golden-polimi-msc-cse-2027.json'));
  const wut = await readGoldenPlan(goldenPath('golden-wut-bsc-cs-2027.json'));
  const node = (plan: GoldenPlan, layer: GoldenNode['layer'], key: string) => {
    const n = plan.nodes.find((x) => x.layer === layer && x.nodeKey === key);
    if (!n) throw new Error(`no ${layer} ${key}`);
    return n;
  };

  it('no pending rulings remain; B5 pricing tier follows the destination country (polimi T3, wut T2)', () => {
    expect(polimi.pending).toEqual([]);
    expect(wut.pending).toEqual([]);
    expect(node(polimi, 'UNIVERSITY', 'polimi').fields['pricing_tier_code']).toBe('T3');
    expect(node(wut, 'UNIVERSITY', 'wut').fields['pricing_tier_code']).toBe('T2');
  });

  it('every column of every node satisfies its layer schema and node key', () => {
    for (const plan of [polimi, wut]) {
      for (const n of plan.nodes) {
        const parsed = LAYERS[n.layer].fields.safeParse(n.fields);
        expect(
          parsed.success,
          `${plan.file} ${n.layer} ${n.nodeKey}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues[0])}`,
        ).toBe(true);
        expect(LAYERS[n.layer].nodeKeyOf(n.fields)).toBe(n.nodeKey);
      }
    }
  });

  it('B1: every primary node is DEEP_VERIFIED with fixture citations (trigger stays strict)', () => {
    for (const plan of [polimi, wut]) {
      for (const n of plan.nodes.filter((x) => x.depth === 'DEEP_VERIFIED')) {
        expect(n.citations.length, `${n.layer} ${n.nodeKey}`).toBeGreaterThan(0);
        for (const c of n.citations) expect(c.verbatim_quote.trim().length).toBeGreaterThanOrEqual(12);
      }
    }
    expect(polimi.nodes.map((n) => `${n.layer}:${n.depth}`)).toEqual([
      'COUNTRY:DEEP_VERIFIED',
      'CITY:DEEP_VERIFIED',
      'ORIGIN_EQUIVALENCY:DEEP_VERIFIED',
      'UNIVERSITY:DEEP_VERIFIED',
      'HOUSING:DEEP_VERIFIED',
      'PROGRAM_SPEC:DEEP_VERIFIED',
    ]);
  });

  it('PoliMi: EUR 3,943 (D-b), DSU_LOMBARDIA, min_bsc_emi_pct 75, NULL classes start (B2), final Non-EU call close (D-c)', () => {
    const f = node(polimi, 'PROGRAM_SPEC', 'polimi:msc-cse:2027-FALL').fields;
    expect(f).toMatchObject({
      tuition_annual_eur: 3943,
      scholarship_waiver_codes_json: ['DSU_LOMBARDIA'],
      min_bsc_emi_pct: 75,
      classes_start_date: null,
      predicted_grades_accepted: true,
      app_window_close_at: '2027-02-25T23:59:00+01:00',
      official_portal_fee_eur_cents: 15_000,
      accepted_prior_fields_json: { exact: ['CS_IT'], adjacent: ['MATH_PHYSICS', 'ELECTRICAL_ENG'] },
    });
    expect(node(polimi, 'CITY', 'IT-MILAN').fields).toMatchObject({
      monthly_living_min_eur: 682,
      monthly_living_max_eur: 1152,
    });
  });

  it('WUT: EUR 11,040, no scholarships, HS EMI rejected, NAWA 60 d (D-a policy alias), 3 Polish <18 consents', () => {
    expect(node(wut, 'PROGRAM_SPEC', 'wut:bsc-cs-networks:2027-FALL').fields).toMatchObject({
      tuition_annual_eur: 11_040,
      scholarship_waiver_codes_json: [],
      high_school_emi_accepted: false,
      predicted_grades_accepted: false,
      classes_start_date: '2027-10-01',
      qualified_docs_deadline_at: '2027-08-15T23:59:00+02:00',
      min_gpa_100: null,
    });
    expect(node(wut, 'ORIGIN_EQUIVALENCY', 'PL:AZ:AZ:CIS_11YR_ATTESTAT:2027-FALL').fields).toMatchObject({
      equivalency_policy: 'DIRECT_WITH_NATIONAL_STATEMENT',
      national_recognition_lead_days: 60,
      ru_sector_translation_exempt: true,
      minor_consents_json: [expect.objectContaining({ code: 'NAWA_SYRENA_GUARDIAN_DECLARATION' })],
    });
    expect(node(wut, 'UNIVERSITY', 'wut').fields).toMatchObject({
      credit_card_accepted: false,
      minor_consents_json: [expect.objectContaining({ code: 'WUT_ISO_PARENTAL_CONSENT' })],
    });
    expect(node(wut, 'CITY', 'PL-WARSAW').fields).toMatchObject({
      monthly_living_min_eur: null,
      minor_consents_json: [expect.objectContaining({ code: 'NFZ_PARENT_CONSENT' })],
    });
  });

  it('D-f: the 6 WUT comparators are BASELINE + ACTIVE with NULL score, inheriting the university-wide rules', () => {
    const alts = wut.nodes.filter((n) => n.layer === 'PROGRAM_SPEC' && n.depth === 'BASELINE');
    expect(alts.map((n) => [n.nodeKey, n.fields['tuition_annual_eur']])).toEqual([
      ['wut:bsc-power-eng:2027-FALL', 4680],
      ['wut:bsc-aerospace-eng:2027-FALL', 4980],
      ['wut:bsc-environmental-eng:2027-FALL', 6000],
      ['wut:bsc-mechatronics:2027-FALL', 7200],
      ['wut:bsc-electrical-eng:2027-FALL', 9000],
      ['wut:bsc-cs-information-systems-mini:2027-FALL', 11_400],
    ]);
    const primary = node(wut, 'PROGRAM_SPEC', 'wut:bsc-cs-networks:2027-FALL').fields;
    for (const a of alts) {
      expect(a).toMatchObject({ score: null, wikiStatus: 'ACTIVE', citations: [] });
      for (const k of [
        'app_window_close_at',
        'qualified_docs_deadline_at',
        'min_english_requirements_json',
        'predicted_grades_accepted',
        'scholarship_waiver_codes_json',
        'accepted_prior_fields_json',
        'classes_start_date',
      ]) {
        expect(a.fields[k], `${a.nodeKey} ${k}`).toEqual(primary[k]);
      }
    }
  });
});
