import { describe, expect, it } from 'vitest';
import { LinkHealerResult, VerificationReport } from '@prometheus/contracts';
import { ModelRouter, type GenerateCall } from '../src/router.js';
import { MemoryEconomics, ScriptedAdapter, okJson } from './support.js';

const PASSING_REPORT = { verification_score: 0.97, checked_paths: ['tuition_annual_eur'], discrepancies: [] };

function verifyCall(excludeFamily?: 'openai-gpt' | 'google-gemini'): GenerateCall<VerificationReport> {
  return {
    route: 'RTE-wiki.deep_verify',
    dataClass: 'OFFICIAL_SOURCE_ONLY',
    idempotencyKey: `t:${Math.random()}`,
    callKey: 'verify:PROGRAM_SPEC:x:run',
    ...(excludeFamily === undefined ? {} : { excludeFamily }),
    vars: {
      layer: 'PROGRAM_SPEC',
      node_key: 'x:2027-FALL',
      season: '2027-FALL',
      required_paths: [],
      proposal: {},
    },
    untrusted: [{ kind: 'web', url: 'https://www.polimi.it/a', text: 'official text' }],
    schema: VerificationReport,
    schemaName: 'verification_report',
  };
}

function setup(
  gemini: ConstructorParameters<typeof ScriptedAdapter>[1] = () => okJson(PASSING_REPORT),
  openai: ConstructorParameters<typeof ScriptedAdapter>[1] = () => okJson(PASSING_REPORT),
) {
  const g = new ScriptedAdapter('google-gemini', gemini);
  const o = new ScriptedAdapter('openai-gpt', openai);
  const econ = new MemoryEconomics();
  const router = new ModelRouter({ adapters: { 'google-gemini': g, 'openai-gpt': o }, economics: econ });
  return { g, o, econ, router };
}

describe('[T2-G4] GR-AI-009 cross-family enforcement on RTE-wiki.deep_verify', () => {
  it("excludeFamily 'openai-gpt' rejects the openai primary (POLICY_DENIED) and serves google-gemini", async () => {
    const { g, o, econ, router } = setup();
    const r = await router.generate(verifyCall('openai-gpt'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.served.family).toBe('google-gemini');
    expect(o.requests).toHaveLength(0);
    expect(g.requests).toHaveLength(1);
    expect(r.attempts.map((a) => `${a.family}:${a.outcome}`)).toEqual([
      'openai-gpt:POLICY_DENIED',
      'google-gemini:OK',
    ]);
    expect(econ.ledger.map((l) => l.outcome)).toEqual(['POLICY_DENIED', 'OK']);
  });

  it("excludeFamily 'google-gemini' never calls gemini and serves openai-gpt", async () => {
    const { g, o, router } = setup();
    const r = await router.generate(verifyCall('google-gemini'));
    expect(r.ok && r.served.family).toBe('openai-gpt');
    expect(g.requests).toHaveLength(0);
    expect(o.requests).toHaveLength(1);
  });

  it('never fails over to the excluded family when the permitted candidate errors', async () => {
    const { g, router } = setup(
      () => okJson(PASSING_REPORT),
      () => ({ kind: 'ERROR', detail: 'upstream 500' }),
    );
    const r = await router.generate(verifyCall('google-gemini'));
    expect(r).toMatchObject({ ok: false, outcome: 'ERROR' });
    expect(g.requests).toHaveLength(0);
  });

  it('deep_verify without excludeFamily is refused outright (no model call)', async () => {
    const { g, o, router } = setup();
    const r = await router.generate(verifyCall());
    expect(r).toMatchObject({ ok: false, outcome: 'POLICY_DENIED' });
    expect(g.requests.length + o.requests.length).toBe(0);
  });
});

describe('[T2-G4] router policy, repair, failover, budget', () => {
  const healerCall = (key: string): GenerateCall<LinkHealerResult> => ({
    route: 'RTE-wiki.link_healer',
    dataClass: 'OFFICIAL_SOURCE_ONLY',
    idempotencyKey: key,
    vars: { missing_url: 'https://pw.edu.pl/x', expected: 'fees', candidates: [] },
    schema: LinkHealerResult,
    schemaName: 'link_healer_result',
  });

  it('schema-invalid output gets exactly one repair retry, then validated output is returned', async () => {
    let n = 0;
    const { g, router } = setup(() =>
      ++n === 1 ? okJson({ chosen: 1 }) : okJson({ chosen_url: null, rationale: 'none fit' }),
    );
    const r = await router.generate(healerCall('repair'));
    expect(r.ok).toBe(true);
    expect(g.requests).toHaveLength(2);
    expect(g.requests[1]?.user).toContain('FAILED SCHEMA VALIDATION');
    expect(g.requests[0]?.cassette.inputHash).not.toBe(g.requests[1]?.cassette.inputHash);
  });

  it('two schema-invalid outputs end as SCHEMA_INVALID (no fabricated value)', async () => {
    const { router } = setup(() => okJson({ nope: true }));
    expect(await router.generate(healerCall('bad'))).toMatchObject({ ok: false, outcome: 'SCHEMA_INVALID' });
  });

  it('ERROR on the primary fails over to the fallback family', async () => {
    const { o, router } = setup(
      () => ({ kind: 'TIMEOUT', detail: 'slow' }),
      () => okJson({ chosen_url: null, rationale: '' }),
    );
    const r = await router.generate(healerCall('failover'));
    expect(r.ok && r.served.family).toBe('openai-gpt');
    expect(o.requests).toHaveLength(1);
    expect(r.attempts.map((a) => a.outcome)).toEqual(['DEADLINE', 'OK']);
  });

  it('a reservation that would cross the cap is a BUDGET outcome and the adapter is never called', async () => {
    const { g, econ, router } = setup();
    await econ.reserve('healer-cap', 'RTE-wiki.link_healer', 0.01, 0.0099);
    const r = await router.generate({ ...healerCall('cap'), callKey: 'healer-cap' });
    expect(r).toMatchObject({ ok: false, outcome: 'BUDGET' });
    expect(g.requests).toHaveLength(0);
    expect(econ.ledger.at(-1)?.outcome).toBe('BUDGET');
  });

  it('a model refusal is ABSTAIN, not a value', async () => {
    const { router } = setup(() => ({ kind: 'REFUSED', detail: 'safety' }));
    expect(await router.generate(healerCall('refuse'))).toMatchObject({ ok: false, outcome: 'ABSTAIN' });
  });

  it('APPLICANT_PII never reaches an endpoint that is not approved for it', async () => {
    const { g, o, router } = setup();
    const r = await router.generate({
      route: 'RTE-matching.triage',
      dataClass: 'APPLICANT_PII',
      idempotencyKey: 'pii',
      vars: { programs: [] },
      untrusted: [{ kind: 'user', url: 'about:applicant-preferences', text: 'near the sea' }],
      schema: LinkHealerResult,
      schemaName: 'x',
    });
    expect(r).toMatchObject({ ok: false, outcome: 'POLICY_DENIED' });
    expect(g.requests.length + o.requests.length).toBe(0);
  });

  it('a data class the route does not allow is refused', async () => {
    const { router } = setup();
    expect(await router.generate({ ...healerCall('dc'), dataClass: 'APPLICANT_PII' })).toMatchObject({
      ok: false,
      outcome: 'POLICY_DENIED',
    });
  });

  it('settles the metered cost so the reservation never stays above actual spend', async () => {
    const { econ, router } = setup(() => okJson({ chosen_url: null, rationale: '' }, 100, 10));
    await router.generate({ ...healerCall('settle'), callKey: 'settle-key' });
    const b = econ.budgets.get('settle-key');
    // gg.lite: (100 * 0.10 + 10 * 0.40) / 1e6
    expect(b?.reserved).toBeCloseTo(0.000014, 9);
  });

  it('the untrusted fence nonce is fresh per call and present in the system prompt', async () => {
    const { g, router } = setup(() => okJson(PASSING_REPORT));
    await router.generate(verifyCall('openai-gpt'));
    await router.generate(verifyCall('openai-gpt'));
    const nonces = g.requests.map((r) => /nonce="([0-9a-f]{32})"/.exec(r.user)?.[1]);
    expect(nonces[0]).toBeDefined();
    expect(nonces[0]).not.toBe(nonces[1]);
    expect(g.requests[0]?.system).toContain(`nonce="${nonces[0] ?? ''}"`);
    // the cassette key excludes the nonce, so replay stays deterministic
    expect(g.requests[0]?.cassette.inputHash).toBe(g.requests[1]?.cassette.inputHash);
  });
});
