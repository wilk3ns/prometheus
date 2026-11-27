import { z } from 'zod';
import { AdmissionSeason, DegreeLevel, DiplomaType, ExamType, Iso2, IsoDate } from './wiki.js';

/** ENG-T2 §5.1 applicant input to the $0 deterministic matcher. */
export const ApplicantExam = z.strictObject({
  type: ExamType,
  status: z.enum(['OBTAINED', 'PLANNED']),
  score: z.number().min(0),
  examDate: IsoDate.optional(),
});
export type ApplicantExam = z.infer<typeof ApplicantExam>;

export const ApplicantMatchInput = z
  .strictObject({
    dob: IsoDate,
    citizenshipCountry: Iso2,
    residenceCountry: Iso2,
    diplomaCountry: Iso2,
    diplomaType: DiplomaType,
    yearsOfSchooling: z.int().min(1).max(25),
    diplomaStatus: z.enum(['ISSUED', 'IN_PROGRESS']),
    expectedDiplomaMonth: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
    priorInstructionLanguage: z.enum(['az', 'ru', 'en', 'tr']),
    priorEmiPct: z.number().min(0).max(100),
    priorFieldCode: z.string().min(1).max(64),
    gpaNormalized100: z.number().min(0).max(100),
    mathGrade100: z.number().min(0).max(100).optional(),
    targetDegree: DegreeLevel,
    targetSeason: AdmissionSeason,
    targetFields: z.array(z.string().min(1).max(200)).max(20),
    preferredCountries: z.array(Iso2).max(10),
    instructionLanguages: z.array(z.string().regex(/^[a-z]{2}$/)).min(1),
    annualBudgetEur: z.number().min(0),
    openToScholarships: z.boolean(),
    householdIncomeUnder25kEur: z.enum(['YES', 'NO', 'UNKNOWN']),
    monthlyLivingBudgetEur: z.number().min(0).optional(),
    exams: z.array(ApplicantExam).max(20),
    unstructuredPreferences: z.array(z.string().min(1).max(500)).max(10).optional(),
  })
  .refine((v) => v.diplomaStatus !== 'IN_PROGRESS' || v.expectedDiplomaMonth !== undefined, {
    message: 'expectedDiplomaMonth is required when diplomaStatus = IN_PROGRESS',
    path: ['expectedDiplomaMonth'],
  });
export type ApplicantMatchInput = z.infer<typeof ApplicantMatchInput>;

export const FitTier = z.enum(['ELIGIBLE_NOW', 'CONDITIONAL', 'REACH']);
export type FitTier = z.infer<typeof FitTier>;

/** Why a program was dropped by an L1 hard exclusion. */
export const ExclusionReason = z.enum([
  'DEGREE_MISMATCH',
  'LANGUAGE_MISMATCH',
  'DEADLINE_TOO_CLOSE',
  'ORIGIN_RULE_UNVERIFIED',
  'NOT_ELIGIBLE_EQUIVALENCY',
  'PRIOR_FIELD_MISMATCH',
  'PREDICTED_GRADES_NOT_ACCEPTED',
  'GPA_BELOW_MIN',
  'OVER_BUDGET',
]);
export type ExclusionReason = z.infer<typeof ExclusionReason>;

/** Reason codes / action flags attached to a match (ENG-T2 §5.2). */
export const ReasonCode = z.enum([
  'FOUNDATION_OR_1YR_REQUIRED',
  'NATIONAL_RECOGNITION_REQUIRED',
  'CALENDAR_CRUNCH_WARNING',
  'CURRICULUM_ECTS_CHECK',
  'SYLLABUS_CHECK_AT_STAGE_5',
  'EXEMPT_VIA_EMI',
  'MISSING_ENGLISH_B2_CERT',
  'ENTRANCE_EXAM_OR_INTERVIEW_REQUIRED',
  'SCHOLARSHIP_DEPENDENT',
  'BUDGET_STRETCH',
  'GPA_STRETCH',
  'MINOR_UNDER_18_CONSENTS',
  /** MEDIUM-4: a consent source (the city layer) is missing or QUARANTINED: the consent list is incomplete. */
  'MINOR_CONSENTS_UNVERIFIED',
  'MINOR_AGE_VERIFY_ACADEMIC_CALENDAR',
  'RU_SECTOR_TRANSLATION_EXEMPT',
  'BANK_TRANSFER_ONLY',
  'LIVING_BUDGET_WARNING',
]);
export type ReasonCode = z.infer<typeof ReasonCode>;

export const MatchFlag = z.strictObject({
  code: ReasonCode,
  /** CONDITIONAL / REACH downgrade the tier; INFO never does. */
  effect: z.enum(['CONDITIONAL', 'REACH', 'INFO']),
  /** Codes the flag refers to (scholarship codes, consent codes, exam codes...). */
  refs: z.array(z.string()),
});
export type MatchFlag = z.infer<typeof MatchFlag>;

export const ProgramMatch = z.strictObject({
  programId: z.string(),
  specId: z.uuid(),
  universityId: z.string(),
  countryIso2: z.string(),
  fitTier: FitTier,
  flags: z.array(MatchFlag),
  tuitionAnnualEur: z.int(),
  /** L2 field similarity 0..100 (pgvector cosine or pg_trgm). */
  fieldScore: z.number().min(0).max(100),
  /** L3 soft boost 0..10 (0 when L3 did not run). */
  softBoost: z.number().min(0).max(10),
  similarityMethod: z.enum(['PGVECTOR', 'PG_TRGM', 'NONE']),
});
export type ProgramMatch = z.infer<typeof ProgramMatch>;

export const ExcludedProgram = z.strictObject({
  programId: z.string(),
  reasons: z.array(ExclusionReason).min(1),
});
export type ExcludedProgram = z.infer<typeof ExcludedProgram>;

export const MatchResult = z.strictObject({
  asOf: z.iso.datetime(),
  matches: z.array(ProgramMatch),
  excluded: z.array(ExcludedProgram),
  l3Applied: z.boolean(),
  llmCostUsd: z.number().min(0),
});
export type MatchResult = z.infer<typeof MatchResult>;
