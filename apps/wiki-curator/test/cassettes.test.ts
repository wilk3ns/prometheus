import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Cassette, writeCassette } from '@prometheus/ai';
import { CASSETTE_DIR, synthesizeCassettes } from './support/curator-scenarios.js';

/**
 * [T2-G5] The committed replay cassettes (repo `cassettes/`) are exactly the ones the WF-03 scenarios need.
 * A prompt, schema or call-builder change alters the keys and fails this test (and would make replay miss
 * loudly). Regenerate deliberately with `UPDATE_CASSETTES=1 pnpm test`.
 */
describe('[T2-G5] replay cassettes are committed and current', () => {
  const synthesized = synthesizeCassettes();

  if (process.env['UPDATE_CASSETTES'] === '1') {
    for (const c of synthesized) writeCassette(CASSETTE_DIR, c);
  }

  it('every cassette a scenario needs is committed with identical content', () => {
    for (const c of synthesized) {
      const file = join(CASSETTE_DIR, `${c.key}.json`);
      expect(existsSync(file), `missing cassette ${c.note}`).toBe(true);
      expect(Cassette.parse(JSON.parse(readFileSync(file, 'utf8')))).toEqual(c);
    }
  });

  it('no stale curator-verify cassettes are left behind', () => {
    const wanted = new Set(synthesized.map((c) => `${c.key}.json`));
    const committed = readdirSync(CASSETTE_DIR).filter((f) => f.endsWith('.json'));
    const stale = committed.filter((f) => {
      const c = Cassette.parse(JSON.parse(readFileSync(join(CASSETTE_DIR, f), 'utf8')));
      return c.note.startsWith('curator-verify ') && !wanted.has(f);
    });
    expect(stale).toEqual([]);
  });

  it('covers the 4 scenarios: Agent B is scripted only where the validator passes', () => {
    const notes = synthesized.map((c) => c.note);
    // Agent B: good + euvsnoneu (identical input in both rounds -> one shared cassette) + locked
    expect(notes.filter((n) => n.includes('Agent B'))).toHaveLength(3);
    expect(
      notes.some((n) => n.includes('euvsnoneu round 1: Agent B') && n.includes('euvsnoneu round 2: Agent B')),
    ).toBe(true);
    expect(notes.filter((n) => n.startsWith('curator-verify halluc') && n.includes('Agent B'))).toHaveLength(
      0,
    );
    // Agent A: the retry round carries the validator / verifier feedback, so every round is distinct
    expect(notes.filter((n) => n.includes('Agent A'))).toHaveLength(6);
  });
});
