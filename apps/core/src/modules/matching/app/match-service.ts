import { sha256Hex, canonicalJson, type ClockPort } from '@prometheus/kernel';
import type { ApplicantMatchInput, MatchResult, ProgramMatch } from '@prometheus/contracts';
import { evaluateL1, TIER_RANK, type L1Match } from '../domain/l1-rules.js';
import type { MatchCatalogPort, QueryEmbedderPort, SimilarityPort, TriagePort } from './ports.js';

/**
 * Stage 2 matching (ENG-T2 §5): L1 (pure $0 rules) -> L2 (pgvector / pg_trgm field similarity) -> optional
 * L3 (RTE-matching.triage soft boost, only with unstructured preferences).
 * GR-AI-004 post-condition: L3 can only re-weight programs L1 already returned; it can never add a program,
 * remove one, or change an L1 fit tier (boosts for unknown ids are discarded, values clamped to 0..10).
 */
export interface MatchServiceDeps {
  readonly catalog: MatchCatalogPort;
  readonly similarity: SimilarityPort;
  readonly embedder: QueryEmbedderPort | undefined;
  readonly triage: TriagePort | undefined;
  readonly clock: ClockPort;
}

export interface MatchOptions {
  /** Evaluation instant (tests and the dev endpoint pin it; defaults to the clock). */
  readonly asOf?: Date;
}

const MAX_BOOST = 10;

/** GR-AI-004: keeps only boosts for L1 programs, clamped; never touches tiers. */
export function applyTriageBoosts(
  l1ProgramIds: ReadonlySet<string>,
  boosts: ReadonlyMap<string, number>,
): Map<string, number> {
  const kept = new Map<string, number>();
  for (const [id, boost] of boosts) {
    if (!l1ProgramIds.has(id) || !Number.isFinite(boost)) continue;
    kept.set(id, Math.min(MAX_BOOST, Math.max(0, boost)));
  }
  return kept;
}

export class MatchService {
  constructor(private readonly deps: MatchServiceDeps) {}

  async match(input: ApplicantMatchInput, options: MatchOptions = {}): Promise<MatchResult> {
    const asOf = options.asOf ?? this.deps.clock.now();
    const catalog = await this.deps.catalog.load(input.targetSeason, input.preferredCountries);
    const l1 = evaluateL1(input, catalog, asOf);
    const ids = l1.matches.map((m) => m.candidate.program.id);
    const requestKey = sha256Hex(canonicalJson({ input, asOf: asOf.toISOString() }));

    let llmCostUsd = 0;
    const query = input.targetFields.join(' ').trim();
    let similarity = new Map<string, { score: number; method: 'PGVECTOR' | 'PG_TRGM' }>();
    if (query !== '' && ids.length > 0) {
      let embedding: readonly number[] | null = null;
      if (this.deps.embedder) {
        const embedded = await this.deps.embedder.embed(query, `match:${requestKey}:embed`);
        embedding = embedded.embedding;
        llmCostUsd += embedded.costUsd;
      }
      similarity = await this.deps.similarity.score(ids, query, embedding);
    }

    let boosts = new Map<string, number>();
    let l3Applied = false;
    const prefs = input.unstructuredPreferences ?? [];
    if (prefs.length > 0 && this.deps.triage && l1.matches.length > 0) {
      const raw = await this.deps.triage.triage(
        l1.matches.map((m) => ({
          programId: m.candidate.program.id,
          name: m.candidate.program.name_en,
          universityId: m.candidate.university.id,
          countryIso2: m.candidate.university.countryIso2,
        })),
        prefs,
        `match:${requestKey}:triage`,
      );
      llmCostUsd += raw.costUsd;
      if (raw.boosts !== null) {
        boosts = applyTriageBoosts(new Set(ids), raw.boosts);
        l3Applied = true;
      }
    }

    const matches = l1.matches
      .map((m: L1Match): ProgramMatch => {
        const sim = similarity.get(m.candidate.program.id);
        return {
          programId: m.candidate.program.id,
          specId: m.candidate.specId,
          universityId: m.candidate.university.id,
          countryIso2: m.candidate.university.countryIso2,
          fitTier: m.fitTier,
          flags: [...m.flags],
          tuitionAnnualEur: m.candidate.spec.tuition_annual_eur,
          fieldScore: sim === undefined ? 0 : Math.round(sim.score * 100),
          softBoost: boosts.get(m.candidate.program.id) ?? 0,
          similarityMethod: sim === undefined ? 'NONE' : sim.method,
        };
      })
      .sort(
        (a, b) =>
          TIER_RANK[a.fitTier] - TIER_RANK[b.fitTier] ||
          b.fieldScore + b.softBoost - (a.fieldScore + a.softBoost) ||
          a.tuitionAnnualEur - b.tuitionAnnualEur ||
          a.programId.localeCompare(b.programId),
      );
    return {
      asOf: asOf.toISOString(),
      matches,
      excluded: l1.excluded.map((e) => ({ programId: e.programId, reasons: [...e.reasons] })),
      l3Applied,
      llmCostUsd,
    };
  }
}
