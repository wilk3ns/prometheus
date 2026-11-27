import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256Hex } from '@prometheus/kernel';
import { z } from 'zod';
import type {
  EmbedRequest,
  EmbedResponse,
  GenerateRequest,
  GenerateResponse,
  ModelAdapterPort,
} from './types.js';

/**
 * Deterministic replay cassettes (ENG-T2 §3.4, `AI_MODE=replay`, the default). One JSON file per call,
 * named `<key>.json`, where key = sha256(canonicalJson({ route, promptHash, tier, excludeFamily, inputHash })).
 * A miss is an explicit ERROR naming the key: replay never improvises an answer, and a prompt/input change
 * can never silently reuse a stale response.
 */

/** Structural key input (a parsed cassette file carries plain strings; CassetteKeyMaterial fits too). */
export interface KeyMaterial {
  readonly route: string;
  readonly promptHash: string;
  readonly tier: string;
  readonly excludeFamily: string | null;
  readonly inputHash: string;
}

export function cassetteKey(material: KeyMaterial): string {
  return sha256Hex(
    canonicalJson({
      route: material.route,
      promptHash: material.promptHash,
      tier: material.tier,
      excludeFamily: material.excludeFamily,
      inputHash: material.inputHash,
    }),
  );
}

const CassetteKeyMaterialSchema = z.strictObject({
  route: z.string(),
  promptHash: z.string(),
  tier: z.string(),
  excludeFamily: z.string().nullable(),
  inputHash: z.string(),
});

export const Cassette = z.strictObject({
  key: z.string().regex(/^[0-9a-f]{64}$/),
  material: CassetteKeyMaterialSchema,
  /** Human note: which test / scenario this cassette serves. */
  note: z.string(),
  response: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('GENERATE'),
      text: z.string(),
      inputTokens: z.int().min(0),
      outputTokens: z.int().min(0),
    }),
    z.strictObject({ kind: z.literal('REFUSED'), detail: z.string() }),
    z.strictObject({
      kind: z.literal('EMBED'),
      embedding: z.array(z.number()),
      inputTokens: z.int().min(0),
    }),
  ]),
});
export type Cassette = z.infer<typeof Cassette>;

export class CassetteStore {
  private readonly byKey = new Map<string, Cassette>();

  constructor(cassettes: readonly Cassette[]) {
    for (const c of cassettes) {
      if (cassetteKey(c.material) !== c.key) {
        throw new Error(`cassette ${c.key} does not match its own key material`);
      }
      this.byKey.set(c.key, c);
    }
  }

  /** Loads every `*.json` cassette of a directory (validated). */
  static fromDirectory(dir: string): CassetteStore {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    return new CassetteStore(
      files.map((f) => Cassette.parse(JSON.parse(readFileSync(join(dir, f), 'utf8')))),
    );
  }

  get(key: string): Cassette | undefined {
    return this.byKey.get(key);
  }

  get size(): number {
    return this.byKey.size;
  }
}

/** Writes a cassette file (`<key>.json`, stable formatting) — used by cassette synthesis tooling. */
export function writeCassette(dir: string, cassette: Cassette): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${cassette.key}.json`), `${JSON.stringify(cassette, null, 2)}\n`, 'utf8');
}

export class ReplayAdapter implements ModelAdapterPort {
  readonly provider = 'replay';
  readonly ledgerFamily = 'replay' as const;
  /** Replay sends nothing anywhere, so it may stand in for any approved endpoint. */
  readonly piiApproved = true;

  constructor(private readonly store: CassetteStore) {}

  generate(request: GenerateRequest): Promise<GenerateResponse> {
    const key = cassetteKey(request.cassette);
    const hit = this.store.get(key);
    if (!hit)
      return Promise.resolve({ kind: 'ERROR', detail: `CASSETTE_MISS ${key} (${request.cassette.route})` });
    if (hit.response.kind === 'GENERATE') {
      return Promise.resolve({
        kind: 'OK',
        text: hit.response.text,
        inputTokens: hit.response.inputTokens,
        outputTokens: hit.response.outputTokens,
      });
    }
    if (hit.response.kind === 'REFUSED')
      return Promise.resolve({ kind: 'REFUSED', detail: hit.response.detail });
    return Promise.resolve({ kind: 'ERROR', detail: `cassette ${key} is an embedding, not a generation` });
  }

  embed(request: EmbedRequest): Promise<EmbedResponse> {
    const key = cassetteKey(request.cassette);
    const hit = this.store.get(key);
    if (!hit)
      return Promise.resolve({ kind: 'ERROR', detail: `CASSETTE_MISS ${key} (${request.cassette.route})` });
    if (hit.response.kind !== 'EMBED') {
      return Promise.resolve({ kind: 'ERROR', detail: `cassette ${key} is not an embedding` });
    }
    return Promise.resolve({
      kind: 'OK',
      embedding: hit.response.embedding,
      inputTokens: hit.response.inputTokens,
    });
  }
}
