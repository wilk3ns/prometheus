import { describe, expect, it } from 'vitest';
import { readGoldenPlan } from '../../../apps/wiki-curator/src/curator/golden-importer.js';
import { evaluateL1 } from '../../../apps/core/src/modules/matching/index.js';
import { catalogFromPlans, gate7Violations, goldenPath, loadGate7Profiles } from './support/golden.js';

/**
 * [T2-G7] The pure $0 L1 engine on the REAL golden records (mapped exactly as the importer maps them), with the
 * ruled Gate 7 profiles and fixed `asOf` clocks. No database, no model: the DB/HTTP leg of Gate 7 is
 * golden-pipeline.golden.it.ts.
 */
describe('[T2-G7] L1 over the mapped golden records (Profiles 1-3)', async () => {
  const plans = [
    await readGoldenPlan(goldenPath('golden-polimi-msc-cse-2027.json')),
    await readGoldenPlan(goldenPath('golden-wut-bsc-cs-2027.json')),
  ];
  const catalog = catalogFromPlans(plans);

  for (const p of loadGate7Profiles()) {
    it(`${p.id}: ${p.label}`, () => {
      const r = evaluateL1(p.input, catalog, new Date(p.asOf));
      const flat = {
        matches: r.matches.map((m) => ({
          programId: m.candidate.program.id,
          fitTier: m.fitTier,
          flags: [...m.flags],
        })),
        excluded: r.excluded.map((e) => ({ programId: e.programId, reasons: [...e.reasons] })),
      };
      expect(gate7Violations(p.id, flat)).toEqual([]);
    });
  }

  it('catalog sanity: 8 programs (2 DEEP_VERIFIED primaries + 6 BASELINE comparators), 2 origin rules', () => {
    expect(catalog.candidates.map((c) => `${c.program.id}:${c.depth}`).sort()).toEqual([
      'polimi:msc-cse:DEEP_VERIFIED',
      'wut:bsc-aerospace-eng:BASELINE',
      'wut:bsc-cs-information-systems-mini:BASELINE',
      'wut:bsc-cs-networks:DEEP_VERIFIED',
      'wut:bsc-electrical-eng:BASELINE',
      'wut:bsc-environmental-eng:BASELINE',
      'wut:bsc-mechatronics:BASELINE',
      'wut:bsc-power-eng:BASELINE',
    ]);
    expect(catalog.originRules).toHaveLength(2);
  });
});
