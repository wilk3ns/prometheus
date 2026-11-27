import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { AdmissionSeason, ApplicantMatchInput, Iso2 } from '@prometheus/contracts';
import type { MatchService, ProgramListingPort } from '../modules/matching/index.js';

/**
 * Minimal HTTP surface of apps/core for T2 (ENG-T2 §1): health + read-only dev/test endpoints.
 * Every body / query is Zod-validated at the boundary; errors are typed JSON, never stack traces.
 *   GET  /healthz
 *   GET  /api/v1/wiki/programs?season=2027-FALL[&country=PL]   matchable programs (read-only)
 *   POST /api/v1/dev/match  { input: ApplicantMatchInput, asOf?: ISO datetime }   $0 deterministic match
 */
const MatchRequest = z.strictObject({
  input: ApplicantMatchInput,
  /** Fixed evaluation clock for tests / demos (ruling: Gate 7 profiles pin `asOf`). */
  asOf: z.iso.datetime({ offset: true }).optional(),
});

const ProgramsQuery = z.strictObject({ season: AdmissionSeason, country: Iso2.optional() });

export interface AppDeps {
  readonly programs: ProgramListingPort;
  readonly matching: MatchService;
  /** LOW-5: dev/test routes exist only when explicitly enabled (INFRA_PROFILE=local). */
  readonly devEndpoints: boolean;
}

const MAX_BODY_BYTES = 64 * 1024;

export function buildApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.onError((error, c) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
    return c.json({ error: 'INTERNAL' }, 500);
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  app.get('/api/v1/wiki/programs', async (c) => {
    const parsed = ProgramsQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'INVALID_QUERY', issues: parsed.error.issues }, 400);
    return c.json({ programs: await deps.programs.listMatchable(parsed.data.season, parsed.data.country) });
  });

  if (!deps.devEndpoints) return app;

  // LOW-5: the cap is enforced on the streamed body (chunked uploads included), not on Content-Length alone
  const capped = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: 'BODY_TOO_LARGE' }, 413),
  });

  app.post('/api/v1/dev/match', capped, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'INVALID_JSON' }, 400);
    }
    const parsed = MatchRequest.safeParse(body);
    if (!parsed.success) return c.json({ error: 'INVALID_INPUT', issues: parsed.error.issues }, 400);
    const result = await deps.matching.match(
      parsed.data.input,
      parsed.data.asOf === undefined ? {} : { asOf: new Date(parsed.data.asOf) },
    );
    return c.json(result);
  });

  return app;
}
