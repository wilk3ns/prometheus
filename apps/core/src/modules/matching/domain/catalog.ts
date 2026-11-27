import type {
  EquivalencyPolicy,
  MinorConsent,
  ProgramFields,
  ProgramSeasonSpecFields,
  VerificationDepth,
  WikiStatus,
} from '@prometheus/contracts';

/**
 * Read model the L1 engine evaluates: one row per program season spec with the university / city / housing
 * facts the rules need, plus the origin-equivalency rules of the season. Loaded by infra (SELECT-only as
 * app_core) and handed to the pure engine; the engine itself does zero I/O.
 */
export interface ProgramCandidate {
  readonly specId: string;
  readonly depth: VerificationDepth;
  readonly wikiStatus: WikiStatus;
  readonly program: ProgramFields;
  readonly spec: Omit<ProgramSeasonSpecFields, 'program_requirements_json'>;
  readonly university: {
    readonly id: string;
    readonly countryIso2: string;
    readonly creditCardAccepted: boolean;
    readonly minorConsents: readonly MinorConsent[];
  };
  readonly city: {
    readonly monthlyLivingMinEur: number | null;
    readonly minorConsents: readonly MinorConsent[];
  } | null;
  readonly housing: { readonly monthlyMinEur: number | null } | null;
}

export interface OriginRuleView {
  readonly destinationCountryIso2: string;
  /** ISO-2, or `'**'` for universal diplomas (IB / A_LEVEL). */
  readonly citizenshipCountry: string;
  readonly diplomaOriginCountry: string;
  readonly diplomaType: string;
  readonly admissionSeason: string;
  readonly equivalencyPolicy: EquivalencyPolicy;
  readonly nationalRecognitionLeadDays: number;
  readonly ruSectorTranslationExempt: boolean;
  readonly minorConsents: readonly MinorConsent[];
  readonly depth: VerificationDepth;
}

export interface MatchCatalog {
  readonly candidates: readonly ProgramCandidate[];
  readonly originRules: readonly OriginRuleView[];
}
