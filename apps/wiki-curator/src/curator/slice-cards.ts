import {
  SLICE_CARD_MAX_CHARS,
  SLICE_CARD_MAX_TOKENS,
  SliceCard,
  type CityProfileFields,
  type Citation,
  type HousingFields,
  type ProgramSpecNodeFields,
  type SliceCardKind,
  type UniversityFields,
  type VerificationDepth,
} from '@prometheus/contracts';

/**
 * Deterministic Slice Card compiler (ENG-T2 §4 step 5.2): a pure TypeScript template, ZERO model tokens.
 * Four card kinds ground the T6 counselor on verified Wiki facts:
 *   card:docs        <- program_season_spec (+ program, university)
 *   card:tuition_aid <- university (+ the season's program tuitions)
 *   card:city        <- city_profile
 *   card:dorms       <- university_housing (+ university)
 * Hard invariant: `Math.ceil(text.length / 4) <= 350` (<= 1,400 chars). A card is assembled from priority-
 * ordered lines (typed facts first, then a canonical flattening of the jsonb payload) and stops before the
 * budget; the `Sources:` line naming the official citation domains is reserved up front and always present.
 */

export interface NodeMeta {
  readonly depth: VerificationDepth;
  readonly version: number;
  readonly citations: readonly Citation[];
}

export interface DocsCardInput extends NodeMeta {
  readonly spec: ProgramSpecNodeFields;
  readonly university: Pick<UniversityFields, 'id' | 'name_en' | 'official_domain'>;
}

export interface TuitionAidCardInput extends NodeMeta {
  readonly university: UniversityFields;
  readonly season: string;
  readonly programs: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly tuitionAnnualEur: number;
    readonly scholarshipCodes: readonly string[];
  }>;
}

export interface CityCardInput extends NodeMeta {
  readonly city: CityProfileFields;
  readonly season: string;
}

export interface DormsCardInput extends NodeMeta {
  readonly housing: HousingFields;
  readonly university: Pick<UniversityFields, 'id' | 'name_en' | 'official_domain'>;
  readonly season: string;
}

export function estimateCardTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function host(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/** Official citation domains, pinned: the node's official domain first, then cited hosts (sorted). */
export function sourceDomains(official: string | undefined, citations: readonly Citation[]): string[] {
  const cited = [
    ...new Set(citations.map((c) => host(c.source_url)).filter((h): h is string => h !== undefined)),
  ].sort();
  const all = official === undefined ? cited : [official, ...cited.filter((h) => h !== official)];
  return all.length > 0 ? all : ['unknown'];
}

/** Canonical flattening of a JSON payload into `path: value` facts (sorted keys, arrays inline). */
export function flattenFacts(value: unknown, prefix = ''): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v !== 'object' || v === null)) {
      return value.length === 0 ? [] : [`${prefix}: ${value.map(String).join(', ')}`];
    }
    return value.flatMap((v, i) => flattenFacts(v, `${prefix}[${i}]`));
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([k, v]) => flattenFacts(v, prefix === '' ? k : `${prefix}.${k}`));
  }
  return [`${prefix}: ${typeof value === 'string' ? value : JSON.stringify(value)}`];
}

function assemble(lines: readonly string[], sources: readonly string[]): string {
  const footer = `Sources: ${sources.join(', ')}`;
  const budget = SLICE_CARD_MAX_CHARS - footer.length - 1;
  let body = '';
  for (const line of lines) {
    const clean = line.replace(/\s+/g, ' ').trim();
    if (clean === '') continue;
    const next = body === '' ? clean : `${body}\n${clean}`;
    if (next.length > budget) {
      // a line that does not fit is cut at a word boundary only if something useful remains
      const room = budget - body.length - (body === '' ? 0 : 1) - 1;
      if (room >= 40) {
        const cut = clean.slice(0, room).replace(/\s+\S*$/, '');
        body = body === '' ? `${cut}…` : `${body}\n${cut}…`;
      }
      break;
    }
    body = next;
  }
  return `${body}\n${footer}`;
}

function finish(
  kind: SliceCardKind,
  nodeId: string,
  season: string,
  meta: NodeMeta,
  lines: string[],
  official: string | undefined,
): SliceCard {
  const domains = sourceDomains(official, meta.citations);
  const text = assemble(lines, domains);
  const card = SliceCard.parse({
    kind,
    node_id: nodeId,
    season,
    text,
    est_tokens: estimateCardTokens(text),
    source_domains: domains,
    verification_depth: meta.depth,
    version: meta.version,
  });
  if (card.est_tokens > SLICE_CARD_MAX_TOKENS)
    throw new Error(`card ${kind}:${nodeId} exceeds ${SLICE_CARD_MAX_TOKENS} tokens`);
  return card;
}

const eur = (n: number): string => `EUR ${n.toLocaleString('en-US')}`;
const day = (iso: string | null): string => (iso === null ? 'n/a' : iso.slice(0, 10));

export function compileDocsCard(input: DocsCardInput): SliceCard {
  const s = input.spec;
  const p = s.program;
  const english = s.min_english_requirements_json;
  const tests = english.accepted_tests
    .map(
      (t) =>
        `${t.exam} ${t.min_score}${t.valid_from ? ` (from ${t.valid_from})` : ''}${t.valid_until ? ` (until ${t.valid_until})` : ''}`,
    )
    .join('; ');
  const lines = [
    `card:docs ${p.id} ${s.admission_season} [${input.depth}]`,
    `${p.name_en} (${p.degree_level}, ${p.instruction_language}, ${p.duration_semesters} sem) at ${input.university.name_en}`,
    `Non-EU tuition: ${eur(s.tuition_annual_eur)}/yr; scholarships: ${s.scholarship_waiver_codes_json.join(', ') || 'none'}`,
    `Application window: ${day(s.app_window_open_at)} to ${day(s.app_window_close_at)}${s.qualified_docs_deadline_at ? `; qualified docs by ${day(s.qualified_docs_deadline_at)}` : ''}`,
    `Classes start: ${s.classes_start_date ?? 'not yet published'}; predicted grades accepted: ${s.predicted_grades_accepted ? 'yes' : 'no'}`,
    `English${english.min_cefr ? ` ${english.min_cefr}` : ''}: ${tests || 'see program rules'}${english.rejected_tests.length ? `; not accepted: ${english.rejected_tests.join(', ')}` : ''}`,
    s.min_bsc_emi_pct !== null
      ? `EMI exemption: >= ${s.min_bsc_emi_pct}% of BSc taught in English`
      : `High-school EMI letter accepted: ${s.high_school_emi_accepted ? 'yes' : 'no'}`,
    s.required_entrance_exams_json.length
      ? `Entrance: ${s.required_entrance_exams_json.map((e) => `${e.code} (${e.kind}, ${e.stage})`).join('; ')}`
      : 'Entrance exam: none',
    s.official_portal_fee_eur_cents !== null
      ? `Portal fee: ${eur(s.official_portal_fee_eur_cents / 100)}`
      : '',
    `Official page: ${p.official_program_url}`,
    ...flattenFacts(s.program_requirements_json),
  ];
  return finish('docs', p.id, s.admission_season, input, lines, input.university.official_domain);
}

export function compileTuitionAidCard(input: TuitionAidCardInput): SliceCard {
  const u = input.university;
  const lines = [
    `card:tuition_aid ${u.id} ${input.season} [${input.depth}]`,
    `${u.name_en} (${u.institution_type}, ${u.country_iso2}); card payments: ${u.credit_card_accepted ? 'accepted' : 'NOT accepted (bank transfer only)'}`,
    ...input.programs.map(
      (p) =>
        `${p.name}: ${eur(p.tuitionAnnualEur)}/yr${p.scholarshipCodes.length ? `; aid: ${p.scholarshipCodes.join(', ')}` : ''}`,
    ),
    ...flattenFacts(u.general_rules_json),
  ];
  return finish('tuition_aid', u.id, input.season, input, lines, u.official_domain);
}

export function compileCityCard(input: CityCardInput): SliceCard {
  const c = input.city;
  const living =
    c.monthly_living_min_eur !== null && c.monthly_living_max_eur !== null
      ? `Monthly living: ${eur(c.monthly_living_min_eur)}-${eur(c.monthly_living_max_eur)}`
      : 'Monthly living (EUR): not published in EUR';
  const lines = [
    `card:city ${c.id} ${input.season} [${input.depth}]`,
    `${c.city_name_en} (${c.country_iso2}). ${living}`,
    ...c.minor_consents_json.map((m) => `Under 18: ${m.authority}: ${m.description}`),
    ...flattenFacts(c.attributes_json),
  ];
  return finish('city', c.id, input.season, input, lines, undefined);
}

export function compileDormsCard(input: DormsCardInput): SliceCard {
  const h = input.housing;
  const range =
    h.monthly_min_eur !== null && h.monthly_max_eur !== null
      ? `${eur(h.monthly_min_eur)}-${eur(h.monthly_max_eur)}/month`
      : 'EUR range not published';
  const lines = [
    `card:dorms ${h.university_id} ${input.season} [${input.depth}]`,
    `${input.university.name_en} housing ${h.rates_season}: ${range}; places: ${h.total_places ?? 'n/a'}`,
    `Non-refundable on visa denial: ${h.non_refundable_on_visa_denial ? 'YES' : 'no'}`,
    `Info: ${h.official_info_url}${h.portal_url ? `; booking: ${h.portal_url}` : ''}`,
    ...flattenFacts(h.critical_rules_json),
    ...h.halls_json.flatMap((hall) => flattenFacts(hall)).slice(0, 40),
  ];
  return finish('dorms', h.university_id, input.season, input, lines, input.university.official_domain);
}

/** Valkey key of a card (ENG-T2 §4: `wiki:card:${kind}:${nodeId}:${season}`, TTL 86400 s). */
export function cardCacheKey(card: Pick<SliceCard, 'kind' | 'node_id' | 'season'>): string {
  return `wiki:card:${card.kind}:${card.node_id}:${card.season}`;
}

export const CARD_TTL_SECONDS = 86_400;
