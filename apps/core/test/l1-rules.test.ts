import { describe, expect, it } from 'vitest';
import {
  applyTriageBoosts,
  defaultSeasonStart,
  evaluateL1,
  isMinorOnDate,
  type MatchCatalog,
} from '../src/modules/matching/index.js';
import { NOW, applicant, candidate, origin } from './support/candidates.js';

const catalog = (
  c: MatchCatalog['candidates'],
  o: MatchCatalog['originRules'] = [origin()],
): MatchCatalog => ({ candidates: c, originRules: o });
const one = (input = applicant(), cands = [candidate('u:p')], origins = [origin()], now = NOW) =>
  evaluateL1(input, catalog(cands, origins), now);
const codes = (r: ReturnType<typeof one>) => r.matches[0]?.flags.map((f) => f.code) ?? [];
const excluded = (r: ReturnType<typeof one>) => r.excluded[0]?.reasons ?? [];

describe('[T2-G7] L1 hard exclusions (ENG-T2 §5.2.1)', () => {
  it('degree, language, 72 h deadline buffer', () => {
    expect(excluded(one(applicant({ targetDegree: 'MASTER' })))).toEqual(['DEGREE_MISMATCH']);
    expect(excluded(one(applicant({ instructionLanguages: ['de'] })))).toEqual(['LANGUAGE_MISMATCH']);
    expect(
      excluded(one(applicant(), [candidate('u:p')], [origin()], new Date('2027-07-13T00:00:00Z'))),
    ).toEqual(['DEADLINE_TOO_CLOSE']);
    expect(
      one(applicant(), [candidate('u:p')], [origin()], new Date('2027-07-12T21:58:00Z')).matches,
    ).toHaveLength(1);
  });

  it('multi-origin lookup fails closed: no matching origin rule -> ORIGIN_RULE_UNVERIFIED (never another country)', () => {
    expect(excluded(one(applicant({ citizenshipCountry: 'KZ', diplomaCountry: 'KZ' })))).toEqual([
      'ORIGIN_RULE_UNVERIFIED',
    ]);
    expect(
      excluded(one(applicant(), [candidate('u:p')], [origin({ destinationCountryIso2: 'IT' })])),
    ).toEqual(['ORIGIN_RULE_UNVERIFIED']);
    expect(excluded(one(applicant(), [candidate('u:p')], [origin({ depth: 'QUARANTINED' })]))).toEqual([
      'ORIGIN_RULE_UNVERIFIED',
    ]);
  });

  it("IB / A_LEVEL fall back to a citizenship '**' rule; other diplomas never do", () => {
    const universal = origin({ citizenshipCountry: '**', diplomaOriginCountry: '**', diplomaType: 'IB' });
    expect(
      one(
        applicant({ diplomaType: 'IB', citizenshipCountry: 'UZ', diplomaCountry: 'UZ' }),
        [candidate('u:p')],
        [universal],
      ).matches,
    ).toHaveLength(1);
    const wildcardAttestat = origin({ citizenshipCountry: '**', diplomaOriginCountry: '**' });
    expect(
      excluded(
        one(
          applicant({ citizenshipCountry: 'UZ', diplomaCountry: 'UZ' }),
          [candidate('u:p')],
          [wildcardAttestat],
        ),
      ),
    ).toEqual(['ORIGIN_RULE_UNVERIFIED']);
  });

  it('NOT_ELIGIBLE equivalency (rule or 11-year override), prior field, predicted grades, GPA', () => {
    expect(
      excluded(one(applicant(), [candidate('u:p')], [origin({ equivalencyPolicy: 'NOT_ELIGIBLE' })])),
    ).toEqual(['NOT_ELIGIBLE_EQUIVALENCY']);
    expect(
      excluded(one(applicant(), [candidate('u:p', { spec: { schooling_11yr_override: 'NOT_ELIGIBLE' } })])),
    ).toEqual(['NOT_ELIGIBLE_EQUIVALENCY']);
    expect(excluded(one(applicant({ priorFieldCode: 'HUMANITIES_QRUP_3' })))).toEqual([
      'PRIOR_FIELD_MISMATCH',
    ]);
    // diploma only in August, window closes mid-July, no predicted grades
    expect(
      excluded(one(applicant({ diplomaStatus: 'IN_PROGRESS', expectedDiplomaMonth: '2027-08' }))),
    ).toEqual(['PREDICTED_GRADES_NOT_ACCEPTED']);
    expect(
      one(applicant({ diplomaStatus: 'IN_PROGRESS', expectedDiplomaMonth: '2027-06' })).matches,
    ).toHaveLength(1);
    expect(
      excluded(one(applicant({ gpaNormalized100: 66.9 }), [candidate('u:p', { spec: { min_gpa_100: 70 } })])),
    ).toEqual(['GPA_BELOW_MIN']);
  });

  it('budget: > 115% excluded unless rescued by a scholarship (need-based DSU not for household income >= 25k)', () => {
    const dsu = candidate('u:p', {
      spec: { tuition_annual_eur: 3943, scholarship_waiver_codes_json: ['DSU_LOMBARDIA'] },
    });
    expect(excluded(one(applicant({ annualBudgetEur: 2000 }), [dsu]))).toEqual(['OVER_BUDGET']);
    const rescued = one(applicant({ annualBudgetEur: 2000, openToScholarships: true }), [dsu]);
    expect(rescued.matches[0]?.fitTier).toBe('CONDITIONAL');
    expect(rescued.matches[0]?.flags).toContainEqual({
      code: 'SCHOLARSHIP_DEPENDENT',
      effect: 'CONDITIONAL',
      refs: ['DSU_LOMBARDIA'],
    });
    expect(
      excluded(
        one(
          applicant({ annualBudgetEur: 2000, openToScholarships: true, householdIncomeUnder25kEur: 'NO' }),
          [dsu],
        ),
      ),
    ).toEqual(['OVER_BUDGET']);
  });

  it('only ACTIVE + (BASELINE | DEEP_VERIFIED) rows of the target season are evaluated (ruling D-f)', () => {
    const rows = [
      candidate('u:a', { candidate: { depth: 'BASELINE' } }),
      candidate('u:b', { candidate: { depth: 'QUARANTINED' } }),
      candidate('u:c', { candidate: { wikiStatus: 'DRAFT' } }),
      candidate('u:d', { spec: { admission_season: '2028-FALL' } }),
    ];
    const r = evaluateL1(applicant(), catalog(rows), NOW);
    expect(r.matches.map((m) => m.candidate.program.id)).toEqual(['u:a']);
    expect(r.excluded).toEqual([]);
  });
});

describe('[T2-G7] L1 tiers and action flags (ENG-T2 §5.2.2)', () => {
  it('equivalency: foundation / 1-year -> CONDITIONAL; national statement -> INFO flag', () => {
    expect(
      one(applicant(), undefined, [origin({ equivalencyPolicy: 'FOUNDATION_REQUIRED' })]).matches[0]?.fitTier,
    ).toBe('CONDITIONAL');
    const nat = one(applicant(), undefined, [
      origin({ equivalencyPolicy: 'DIRECT_WITH_NATIONAL_STATEMENT' }),
    ]);
    expect(nat.matches[0]?.fitTier).toBe('ELIGIBLE_NOW');
    expect(codes(nat)).toContain('NATIONAL_RECOGNITION_REQUIRED');
  });

  it('calendar crunch: June diploma + 60 d recognition after the mid-August docs deadline', () => {
    const r = one(applicant({ diplomaStatus: 'IN_PROGRESS', expectedDiplomaMonth: '2027-06' }), undefined, [
      origin({ nationalRecognitionLeadDays: 60 }),
    ]);
    expect(r.matches[0]?.fitTier).toBe('CONDITIONAL');
    expect(codes(r)).toContain('CALENDAR_CRUNCH_WARNING');
    const ok = one(applicant({ diplomaStatus: 'IN_PROGRESS', expectedDiplomaMonth: '2027-05' }), undefined, [
      origin({ nationalRecognitionLeadDays: 60 }),
    ]);
    expect(codes(ok)).not.toContain('CALENDAR_CRUNCH_WARNING'); // 22 May + 60 d = 21 Jul < 15 Aug
  });

  it('prior field: adjacent -> CONDITIONAL (CURRICULUM_ECTS_CHECK); exact on MASTER -> INFO badge', () => {
    expect(one(applicant({ priorFieldCode: 'ECON_QRUP_2' })).matches[0]?.flags).toContainEqual({
      code: 'CURRICULUM_ECTS_CHECK',
      effect: 'CONDITIONAL',
      refs: [],
    });
    const master = candidate('u:m', {
      program: { degree_level: 'MASTER' },
      spec: { accepted_prior_fields_json: { exact: ['CS_IT'], adjacent: [] } },
    });
    const r = one(
      applicant({ targetDegree: 'MASTER', priorFieldCode: 'CS_IT', diplomaType: 'BACHELOR_DEGREE' }),
      [master],
      [origin({ diplomaType: 'BACHELOR_DEGREE' })],
    );
    expect(codes(r)).toContain('SYLLABUS_CHECK_AT_STAGE_5');
  });

  it('English: EMI exemption first; TOEFL scale switch on 2026-01-21; DUOLINGO / PLANNED / HS EMI -> MISSING_ENGLISH_B2_CERT', () => {
    const master = candidate('u:m', {
      program: { degree_level: 'MASTER' },
      spec: { min_bsc_emi_pct: 75, accepted_prior_fields_json: { exact: ['CS_IT'], adjacent: [] } },
    });
    const masterInput = {
      targetDegree: 'MASTER' as const,
      priorFieldCode: 'CS_IT',
      diplomaType: 'BACHELOR_DEGREE' as const,
      exams: [],
    };
    const bscOrigin = [origin({ diplomaType: 'BACHELOR_DEGREE' })];
    expect(codes(one(applicant({ ...masterInput, priorEmiPct: 100 }), [master], bscOrigin))).toContain(
      'EXEMPT_VIA_EMI',
    );
    expect(codes(one(applicant({ ...masterInput, priorEmiPct: 74 }), [master], bscOrigin))).toContain(
      'MISSING_ENGLISH_B2_CERT',
    );

    const toefl = (score: number, examDate?: string) =>
      applicant({
        exams: [{ type: 'TOEFL_IBT', status: 'OBTAINED', score, ...(examDate ? { examDate } : {}) }],
      });
    expect(codes(one(toefl(4.5, '2026-03-01')))).not.toContain('MISSING_ENGLISH_B2_CERT');
    expect(codes(one(toefl(4.5, '2025-12-01')))).toContain('MISSING_ENGLISH_B2_CERT'); // old scale needs 87
    expect(codes(one(toefl(90, '2025-12-01')))).not.toContain('MISSING_ENGLISH_B2_CERT');
    expect(codes(one(toefl(90)))).toContain('MISSING_ENGLISH_B2_CERT'); // undated score cannot be placed on a scale
    expect(
      codes(one(applicant({ exams: [{ type: 'DUOLINGO', status: 'OBTAINED', score: 140 }] }))),
    ).toContain('MISSING_ENGLISH_B2_CERT');
    expect(
      codes(one(applicant({ exams: [{ type: 'IELTS_ACADEMIC', status: 'PLANNED', score: 7 }] }))),
    ).toContain('MISSING_ENGLISH_B2_CERT');
    expect(codes(one(applicant({ exams: [], priorEmiPct: 100 })))).toContain('MISSING_ENGLISH_B2_CERT'); // HS EMI not accepted
    const hsEmi = candidate('u:h', { spec: { high_school_emi_accepted: true } });
    expect(codes(one(applicant({ exams: [], priorEmiPct: 100 }), [hsEmi]))).toContain('EXEMPT_VIA_EMI');
  });

  it('entrance exam / interview: PRE_ADMISSION unmet -> CONDITIONAL; satisfied by an OBTAINED exam -> nothing', () => {
    const tolc = candidate('u:t', {
      spec: {
        required_entrance_exams_json: [
          { code: 'TOLC_I', kind: 'EXAM', satisfied_by: ['TOLC_I'], mandatory: true, stage: 'PRE_ADMISSION' },
        ],
      },
    });
    expect(one(applicant(), [tolc]).matches[0]?.flags).toContainEqual({
      code: 'ENTRANCE_EXAM_OR_INTERVIEW_REQUIRED',
      effect: 'CONDITIONAL',
      refs: ['TOLC_I'],
    });
    const passed = applicant({
      exams: [
        { type: 'IELTS_ACADEMIC', status: 'OBTAINED', score: 7 },
        { type: 'TOLC_I', status: 'OBTAINED', score: 30 },
      ],
    });
    expect(codes(one(passed, [tolc]))).not.toContain('ENTRANCE_EXAM_OR_INTERVIEW_REQUIRED');
  });

  it('REACH stretch bands: tuition in (100%, 115%] of budget; GPA in [min-3, min)', () => {
    expect(one(applicant({ annualBudgetEur: 3600 })).matches[0]).toMatchObject({ fitTier: 'REACH' });
    expect(codes(one(applicant({ annualBudgetEur: 3600 })))).toContain('BUDGET_STRETCH');
    const gpa = one(applicant({ gpaNormalized100: 68 }), [candidate('u:p', { spec: { min_gpa_100: 70 } })]);
    expect(gpa.matches[0]).toMatchObject({ fitTier: 'REACH' });
  });

  it('operational flags: <18 consents aggregated from origin + university + city; RU sector; bank transfer; living budget', () => {
    const consent = (code: string) => ({ code, authority: 'a', description: 'd', form_url: null });
    const c = candidate('u:p', {
      candidate: {
        university: {
          id: 'u',
          countryIso2: 'PL',
          creditCardAccepted: false,
          minorConsents: [consent('UNI')],
        },
        city: { monthlyLivingMinEur: 700, minorConsents: [consent('CITY')] },
        housing: { monthlyMinEur: null },
      },
    });
    const r = one(
      applicant({ dob: '2010-02-15', priorInstructionLanguage: 'ru', monthlyLivingBudgetEur: 500 }),
      [c],
      [origin({ ruSectorTranslationExempt: true, minorConsents: [consent('ORIGIN')] })],
    );
    const flags = r.matches[0]?.flags ?? [];
    expect(flags).toContainEqual({
      code: 'MINOR_UNDER_18_CONSENTS',
      effect: 'INFO',
      refs: ['ORIGIN', 'UNI', 'CITY'],
    });
    expect(flags.map((f) => f.code)).toEqual(
      expect.arrayContaining(['RU_SECTOR_TRANSLATION_EXEMPT', 'BANK_TRANSFER_ONLY', 'LIVING_BUDGET_WARNING']),
    );
    const az = one(
      applicant({ dob: '2010-02-15', priorInstructionLanguage: 'az' }),
      [c],
      [origin({ ruSectorTranslationExempt: true })],
    );
    expect(codes(az)).not.toContain('RU_SECTOR_TRANSLATION_EXEMPT');
  });

  it('ruling B2: NULL classes_start_date -> defaultSeasonStart + MINOR_AGE_VERIFY_ACADEMIC_CALENDAR within +-30 days of 18', () => {
    expect(defaultSeasonStart('2027-FALL')).toBe('2027-09-15');
    expect(defaultSeasonStart('2028-SPRING')).toBe('2028-02-15');
    const noStart = candidate('u:p', { spec: { classes_start_date: null } });
    const near = one(applicant({ dob: '2009-10-01' }), [noStart]); // turns 18 on 2027-10-01: 16 days after 09-15
    expect(codes(near)).toContain('MINOR_AGE_VERIFY_ACADEMIC_CALENDAR');
    expect(codes(near)).toContain('MINOR_UNDER_18_CONSENTS'); // still a minor on the fallback date
    expect(codes(one(applicant({ dob: '2009-08-01' }), [noStart]))).not.toContain(
      'MINOR_AGE_VERIFY_ACADEMIC_CALENDAR',
    );
    expect(codes(one(applicant({ dob: '2009-10-01' })))).not.toContain('MINOR_AGE_VERIFY_ACADEMIC_CALENDAR'); // published start date
    expect(isMinorOnDate('2009-10-01', '2027-09-30')).toBe(true);
    expect(isMinorOnDate('2009-10-01', '2027-10-01')).toBe(false);
  });
});

describe('[T2-G7] GR-AI-004 L3 post-condition', () => {
  it('drops boosts for programs L1 did not return and clamps to 0..10', () => {
    const kept = applyTriageBoosts(
      new Set(['a', 'b']),
      new Map([
        ['a', 50],
        ['b', -3],
        ['injected', 10],
      ]),
    );
    expect([...kept.entries()]).toEqual([
      ['a', 10],
      ['b', 0],
    ]);
  });
});

describe('[T2-G7] performance: 250 active specs in < 20 ms, zero I/O', () => {
  it('evaluates 250 cloned specs well under 20 ms (median of 25 runs)', () => {
    const rows = Array.from({ length: 250 }, (_, i) =>
      candidate(`u${i % 25}:p${i}`, {
        spec: { tuition_annual_eur: 2000 + (i % 40) * 250, min_gpa_100: i % 3 === 0 ? 70 : null },
      }),
    );
    const cat = catalog(rows, [origin({ nationalRecognitionLeadDays: 60 })]);
    const input = applicant({
      diplomaStatus: 'IN_PROGRESS',
      expectedDiplomaMonth: '2027-06',
      dob: '2010-02-15',
      openToScholarships: true,
    });
    for (let i = 0; i < 5; i += 1) evaluateL1(input, cat, NOW); // warm-up
    const samples: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const t = performance.now();
      const r = evaluateL1(input, cat, NOW);
      samples.push(performance.now() - t);
      expect(r.matches.length + r.excluded.length).toBe(250);
    }
    samples.sort((a, b) => a - b);
    const median = samples[12] ?? Infinity;
    console.log(
      `[T2-G7] L1 250 specs: median ${median.toFixed(3)} ms, max ${(samples.at(-1) ?? 0).toFixed(3)} ms`,
    );
    expect(median).toBeLessThan(20);
    expect(samples.at(-1)).toBeLessThan(20);
  });
});
