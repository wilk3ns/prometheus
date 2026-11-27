import type {
  ApplicantMatchInput,
  EnglishRequirements,
  ExclusionReason,
  FitTier,
  MatchFlag,
  MinorConsent,
  ReasonCode,
} from '@prometheus/contracts';
import type { MatchCatalog, OriginRuleView, ProgramCandidate } from './catalog.js';

/**
 * Pure $0 deterministic L1 rule engine (ENG-T2 §5.2). No model, no database, no network: the same input,
 * catalog and clock always produce the same output, in well under 20 ms for 250 programs.
 *
 * Matchable rows (ruling D-f): `wiki_status = 'ACTIVE' AND verification_depth IN ('BASELINE','DEEP_VERIFIED')`.
 * Hard exclusions drop a program (with reasons); everything else starts ELIGIBLE_NOW and is downgraded by
 * flags to CONDITIONAL (fixable / pre-admission gates) or REACH (stretch bands). INFO flags never downgrade.
 */

export interface L1Match {
  readonly candidate: ProgramCandidate;
  readonly fitTier: FitTier;
  readonly flags: readonly MatchFlag[];
}

export interface L1Result {
  readonly matches: readonly L1Match[];
  readonly excluded: ReadonlyArray<{
    readonly programId: string;
    readonly reasons: readonly ExclusionReason[];
  }>;
}

const DAY_MS = 86_400_000;
const DEADLINE_SAFETY_MS = 72 * 3_600_000;
const BUDGET_TOLERANCE = 1.15;
const GPA_STRETCH_POINTS = 3;
const MINOR_CALENDAR_UNCERTAINTY_DAYS = 30;
/** Universal diplomas may fall back to a `citizenship_country = '**'` origin rule (§5.2). */
const UNIVERSAL_DIPLOMAS: ReadonlySet<string> = new Set(['IB', 'A_LEVEL']);
const TIER_RANK: Readonly<Record<FitTier, number>> = { ELIGIBLE_NOW: 0, CONDITIONAL: 1, REACH: 2 };

// ---- calendar helpers (UTC, deterministic) ----

function utcDate(isoDate: string): number {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) throw new RangeError(`bad date ${isoDate}`);
  return Date.UTC(y, m - 1, d);
}

/** Last instant of a `YYYY-MM` month. */
export function endOfMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  if (y === undefined || m === undefined) throw new RangeError(`bad month ${month}`);
  return Date.UTC(y, m, 1) - 1;
}

/** `YYYY-FALL` -> `YYYY-09-15`, `YYYY-SPRING` -> `YYYY-02-15` (ruling B2). */
export function defaultSeasonStart(season: string): string {
  const [year, term] = season.split('-');
  if (year === undefined || (term !== 'FALL' && term !== 'SPRING'))
    throw new RangeError(`bad season ${season}`);
  return term === 'FALL' ? `${year}-09-15` : `${year}-02-15`;
}

/** UTC instant of the 18th birthday (29 Feb rolls to 1 Mar in non-leap years, as Date.UTC does). */
export function eighteenthBirthday(dob: string): number {
  const [y, m, d] = dob.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined) throw new RangeError(`bad dob ${dob}`);
  return Date.UTC(y + 18, m - 1, d);
}

export function isMinorOnDate(dob: string, date: string): boolean {
  return eighteenthBirthday(dob) > utcDate(date);
}

// ---- rule helpers ----

/** Need-based scholarship codes (an applicant with household income >= EUR 25k cannot rely on them). */
export function isNeedBasedScholarship(code: string): boolean {
  return code.startsWith('DSU_');
}

function originKey(
  dest: string,
  citizenship: string,
  diplomaCountry: string,
  diplomaType: string,
  season: string,
): string {
  return `${dest}|${citizenship}|${diplomaCountry}|${diplomaType}|${season}`;
}

export function indexOriginRules(rules: readonly OriginRuleView[]): Map<string, OriginRuleView> {
  const index = new Map<string, OriginRuleView>();
  for (const r of rules) {
    if (r.depth === 'QUARANTINED') continue;
    index.set(
      originKey(
        r.destinationCountryIso2,
        r.citizenshipCountry,
        r.diplomaOriginCountry,
        r.diplomaType,
        r.admissionSeason,
      ),
      r,
    );
  }
  return index;
}

/** Exact (destination, citizenship, diploma country, diploma type, season); `'**'` only for IB / A_LEVEL. */
export function resolveOriginRule(
  index: ReadonlyMap<string, OriginRuleView>,
  destination: string,
  input: Pick<ApplicantMatchInput, 'citizenshipCountry' | 'diplomaCountry' | 'diplomaType' | 'targetSeason'>,
): OriginRuleView | undefined {
  const exact = index.get(
    originKey(
      destination,
      input.citizenshipCountry,
      input.diplomaCountry,
      input.diplomaType,
      input.targetSeason,
    ),
  );
  if (exact !== undefined || !UNIVERSAL_DIPLOMAS.has(input.diplomaType)) return exact;
  return (
    index.get(originKey(destination, '**', input.diplomaCountry, input.diplomaType, input.targetSeason)) ??
    index.get(originKey(destination, '**', '**', input.diplomaType, input.targetSeason))
  );
}

function withinWindow(examDate: string | undefined, from: string | null, until: string | null): boolean {
  if (from === null && until === null) return true;
  if (examDate === undefined) return false; // a dated scale cannot be applied to an undated score
  if (from !== null && examDate < from) return false;
  if (until !== null && examDate > until) return false;
  return true;
}

type EnglishOutcome = 'EXEMPT_VIA_EMI' | 'MET' | 'MISSING';

export function evaluateEnglish(
  input: ApplicantMatchInput,
  degree: 'BACHELOR' | 'MASTER',
  spec: {
    readonly min_bsc_emi_pct: number | null;
    readonly high_school_emi_accepted: boolean;
    readonly min_english_requirements_json: EnglishRequirements;
  },
): EnglishOutcome {
  if (degree === 'MASTER' && spec.min_bsc_emi_pct !== null && input.priorEmiPct >= spec.min_bsc_emi_pct)
    return 'EXEMPT_VIA_EMI';
  if (degree === 'BACHELOR' && spec.high_school_emi_accepted && input.priorEmiPct === 100)
    return 'EXEMPT_VIA_EMI';
  const req = spec.min_english_requirements_json;
  const met = input.exams.some(
    (exam) =>
      exam.status === 'OBTAINED' &&
      !req.rejected_tests.includes(exam.type) &&
      req.accepted_tests.some(
        (t) =>
          t.exam === exam.type &&
          exam.score >= t.min_score &&
          withinWindow(exam.examDate, t.valid_from, t.valid_until),
      ),
  );
  return met ? 'MET' : 'MISSING';
}

function aggregateConsents(...lists: ReadonlyArray<readonly MinorConsent[] | undefined>): string[] {
  const codes: string[] = [];
  for (const list of lists) for (const c of list ?? []) if (!codes.includes(c.code)) codes.push(c.code);
  return codes;
}

function flag(code: ReasonCode, effect: MatchFlag['effect'], refs: readonly string[] = []): MatchFlag {
  return { code, effect, refs: [...refs] };
}

/** Evaluates one candidate: either exclusion reasons or the tier + flags. */
export function evaluateCandidate(
  input: ApplicantMatchInput,
  c: ProgramCandidate,
  originIndex: ReadonlyMap<string, OriginRuleView>,
  nowMs: number,
):
  { kind: 'EXCLUDED'; reasons: ExclusionReason[] } | { kind: 'MATCH'; fitTier: FitTier; flags: MatchFlag[] } {
  const { spec, program } = c;
  const reasons: ExclusionReason[] = [];
  const flags: MatchFlag[] = [];
  const closeMs = Date.parse(spec.app_window_close_at);

  // 1. hard exclusions
  if (program.degree_level !== input.targetDegree) reasons.push('DEGREE_MISMATCH');
  if (!input.instructionLanguages.includes(program.instruction_language)) reasons.push('LANGUAGE_MISMATCH');
  if (closeMs <= nowMs + DEADLINE_SAFETY_MS) reasons.push('DEADLINE_TOO_CLOSE');
  const origin = resolveOriginRule(originIndex, c.university.countryIso2, input);
  if (origin === undefined) reasons.push('ORIGIN_RULE_UNVERIFIED'); // fail closed: never borrow another rule
  const policy = spec.schooling_11yr_override ?? origin?.equivalencyPolicy;
  if (policy === 'NOT_ELIGIBLE') reasons.push('NOT_ELIGIBLE_EQUIVALENCY');
  const fields = spec.accepted_prior_fields_json;
  const exactField = fields.exact.includes(input.priorFieldCode);
  const adjacentField = !exactField && fields.adjacent.includes(input.priorFieldCode);
  if (!exactField && !adjacentField) reasons.push('PRIOR_FIELD_MISMATCH');
  if (
    input.diplomaStatus === 'IN_PROGRESS' &&
    !spec.predicted_grades_accepted &&
    input.expectedDiplomaMonth !== undefined &&
    closeMs < endOfMonth(input.expectedDiplomaMonth)
  ) {
    reasons.push('PREDICTED_GRADES_NOT_ACCEPTED');
  }
  if (spec.min_gpa_100 !== null && input.gpaNormalized100 < spec.min_gpa_100 - GPA_STRETCH_POINTS)
    reasons.push('GPA_BELOW_MIN');
  const tuition = spec.tuition_annual_eur;
  const budget = input.annualBudgetEur;
  const codes = spec.scholarship_waiver_codes_json;
  const overTolerance = tuition > budget * BUDGET_TOLERANCE;
  const rescuable =
    input.openToScholarships &&
    codes.length > 0 &&
    !(codes.some(isNeedBasedScholarship) && input.householdIncomeUnder25kEur === 'NO');
  if (overTolerance && !rescuable) reasons.push('OVER_BUDGET');
  if (reasons.length > 0) return { kind: 'EXCLUDED', reasons };

  // 2. tier classification + action flags
  if (policy === 'FOUNDATION_REQUIRED' || policy === 'ONE_YEAR_UNI_REQUIRED')
    flags.push(flag('FOUNDATION_OR_1YR_REQUIRED', 'CONDITIONAL'));
  if (policy === 'DIRECT_WITH_NATIONAL_STATEMENT') flags.push(flag('NATIONAL_RECOGNITION_REQUIRED', 'INFO'));
  if (
    origin !== undefined &&
    input.diplomaStatus === 'IN_PROGRESS' &&
    input.expectedDiplomaMonth !== undefined &&
    origin.nationalRecognitionLeadDays > 0 &&
    spec.qualified_docs_deadline_at !== null
  ) {
    const estimatedIssue = utcDate(`${input.expectedDiplomaMonth}-22`);
    if (
      estimatedIssue + origin.nationalRecognitionLeadDays * DAY_MS >
      Date.parse(spec.qualified_docs_deadline_at)
    ) {
      flags.push(
        flag('CALENDAR_CRUNCH_WARNING', 'CONDITIONAL', [`lead_days:${origin.nationalRecognitionLeadDays}`]),
      );
    }
  }
  if (adjacentField) flags.push(flag('CURRICULUM_ECTS_CHECK', 'CONDITIONAL'));
  if (exactField && program.degree_level === 'MASTER') flags.push(flag('SYLLABUS_CHECK_AT_STAGE_5', 'INFO'));

  const english = evaluateEnglish(input, program.degree_level, spec);
  if (english === 'EXEMPT_VIA_EMI') flags.push(flag('EXEMPT_VIA_EMI', 'INFO'));
  if (english === 'MISSING') flags.push(flag('MISSING_ENGLISH_B2_CERT', 'CONDITIONAL'));

  const obtained = new Set(input.exams.filter((e) => e.status === 'OBTAINED').map((e) => e.type));
  for (const req of spec.required_entrance_exams_json) {
    if (!req.mandatory || req.satisfied_by.some((t) => obtained.has(t))) continue;
    flags.push(
      flag('ENTRANCE_EXAM_OR_INTERVIEW_REQUIRED', req.stage === 'PRE_ADMISSION' ? 'CONDITIONAL' : 'INFO', [
        req.code,
      ]),
    );
  }

  if (overTolerance && rescuable) flags.push(flag('SCHOLARSHIP_DEPENDENT', 'CONDITIONAL', codes));
  if (tuition > budget && !overTolerance) flags.push(flag('BUDGET_STRETCH', 'REACH'));
  if (spec.min_gpa_100 !== null && input.gpaNormalized100 < spec.min_gpa_100)
    flags.push(flag('GPA_STRETCH', 'REACH'));

  const startDate = spec.classes_start_date ?? defaultSeasonStart(spec.admission_season);
  if (isMinorOnDate(input.dob, startDate)) {
    flags.push(
      flag(
        'MINOR_UNDER_18_CONSENTS',
        'INFO',
        aggregateConsents(origin?.minorConsents, c.university.minorConsents, c.city?.minorConsents),
      ),
    );
  }
  if (
    spec.classes_start_date === null &&
    Math.abs(eighteenthBirthday(input.dob) - utcDate(startDate)) <= MINOR_CALENDAR_UNCERTAINTY_DAYS * DAY_MS
  ) {
    flags.push(flag('MINOR_AGE_VERIFY_ACADEMIC_CALENDAR', 'INFO', [startDate]));
  }
  if (origin?.ruSectorTranslationExempt === true && input.priorInstructionLanguage === 'ru') {
    flags.push(flag('RU_SECTOR_TRANSLATION_EXEMPT', 'INFO'));
  }
  if (!c.university.creditCardAccepted) flags.push(flag('BANK_TRANSFER_ONLY', 'INFO'));
  const livingFloor = c.housing?.monthlyMinEur ?? c.city?.monthlyLivingMinEur ?? null;
  if (
    input.monthlyLivingBudgetEur !== undefined &&
    livingFloor !== null &&
    input.monthlyLivingBudgetEur < livingFloor
  ) {
    flags.push(flag('LIVING_BUDGET_WARNING', 'INFO', [`floor_eur:${livingFloor}`]));
  }

  let fitTier: FitTier = 'ELIGIBLE_NOW';
  for (const f of flags) {
    const tier: FitTier | undefined = f.effect === 'INFO' ? undefined : f.effect;
    if (tier !== undefined && TIER_RANK[tier] > TIER_RANK[fitTier]) fitTier = tier;
  }
  return { kind: 'MATCH', fitTier, flags };
}

export function isMatchable(c: ProgramCandidate): boolean {
  return c.wikiStatus === 'ACTIVE' && (c.depth === 'BASELINE' || c.depth === 'DEEP_VERIFIED');
}

/** Evaluates the whole catalog for one applicant at `now`. */
export function evaluateL1(input: ApplicantMatchInput, catalog: MatchCatalog, now: Date): L1Result {
  const index = indexOriginRules(catalog.originRules);
  const nowMs = now.getTime();
  const matches: L1Match[] = [];
  const excluded: Array<{ programId: string; reasons: ExclusionReason[] }> = [];
  for (const candidate of catalog.candidates) {
    if (!isMatchable(candidate) || candidate.spec.admission_season !== input.targetSeason) continue;
    const r = evaluateCandidate(input, candidate, index, nowMs);
    if (r.kind === 'EXCLUDED') excluded.push({ programId: candidate.program.id, reasons: r.reasons });
    else matches.push({ candidate, fitTier: r.fitTier, flags: r.flags });
  }
  return { matches, excluded };
}

export { TIER_RANK };
