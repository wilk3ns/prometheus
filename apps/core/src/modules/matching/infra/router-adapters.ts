import { TriageResult } from '@prometheus/contracts';
import type { ModelRouter } from '@prometheus/ai';
import type { QueryEmbedderPort, TriagePort, TriageProgram } from '../app/ports.js';

/**
 * L2/L3 model access for matching, only through the ModelRouter. Applicant preference text is APPLICANT_PII:
 * the router serves it only from EU-approved endpoints (or replay). Program metadata sent to triage carries
 * no applicant data.
 */
export class RouterTriage implements TriagePort {
  constructor(private readonly router: ModelRouter) {}

  async triage(programs: readonly TriageProgram[], preferences: readonly string[], idempotencyKey: string) {
    const result = await this.router.generate({
      route: 'RTE-matching.triage',
      dataClass: 'APPLICANT_PII',
      idempotencyKey,
      vars: {
        programs: programs.map((p) => ({
          program_id: p.programId,
          name: p.name,
          university: p.universityId,
          country: p.countryIso2,
        })),
      },
      untrusted: preferences.map((text) => ({
        kind: 'user' as const,
        url: 'about:applicant-preferences',
        text,
      })),
      schema: TriageResult,
      schemaName: 'triage_result',
    });
    if (!result.ok) return { boosts: null, costUsd: result.costUsd };
    return {
      boosts: new Map(result.value.boosts.map((b) => [b.program_id, b.boost])),
      costUsd: result.costUsd,
    };
  }
}

export class RouterQueryEmbedder implements QueryEmbedderPort {
  constructor(private readonly router: ModelRouter) {}

  async embed(text: string, idempotencyKey: string) {
    const result = await this.router.embed({ dataClass: 'APPLICANT_PII', idempotencyKey, text });
    return result.ok
      ? { embedding: result.embedding, costUsd: result.costUsd }
      : { embedding: null, costUsd: 0 };
  }
}
