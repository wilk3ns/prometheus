import { SliceCard, type SliceCardKind, type WikiLayer } from '@prometheus/contracts';
import type { CachePort } from '@prometheus/infra-ports';
import type { StoredNode, WikiLayerStore } from '../persistence/wiki-layer-repository.js';
import {
  CARD_TTL_SECONDS,
  cardCacheKey,
  compileCityCard,
  compileDocsCard,
  compileDormsCard,
  compileTuitionAidCard,
} from './slice-cards.js';

/**
 * 3-View Materializer (ENG-T2 §4 step 5): after a node commit, inside the SAME wiki_writer transaction,
 *  1. typed SQL columns are already written by the layer repository;
 *  2. the deterministic Slice Cards that depend on the node are (re)compiled into `agent_slice_card_json`;
 *     a PROGRAM_SPEC commit compiles all 4 cards of its context (docs, tuition_aid, city, dorms);
 *  3. `wiki.program_embedding.search_text` is upserted for pg_trgm (vectors are filled by a separate,
 *     optional embed step outside the transaction; NULL is the supported pg_trgm fallback).
 * QUARANTINED nodes never get a card. Valkey caching happens after commit (CardCache), never before.
 */

export interface CardRef {
  readonly kind: SliceCardKind;
  readonly nodeId: string;
  readonly season: string;
}

export interface MaterializeResult {
  readonly cards: readonly SliceCard[];
  /** Cards that must be evicted from the cache (their node is QUARANTINED). */
  readonly evict: readonly CardRef[];
  readonly searchTexts: ReadonlyArray<{ readonly programId: string; readonly text: string }>;
}

const live = <N extends StoredNode>(n: N | undefined): n is N => n !== undefined && n.depth !== 'QUARANTINED';

/** Terms for pg_trgm / embedding search: title + specialisation + modules + field + city/university. */
export function programSearchText(
  spec: StoredNode<'PROGRAM_SPEC'>,
  university: StoredNode<'UNIVERSITY'> | undefined,
  city: StoredNode<'CITY'> | undefined,
): string {
  const p = spec.fields.program;
  const modules: string[] = [];
  const walk = (value: unknown, key: string): void => {
    if (modules.length >= 40) return;
    if (typeof value === 'string' && /(module|track|speciali[sz])/i.test(key)) modules.push(value);
    else if (Array.isArray(value)) value.forEach((v) => walk(v, key));
    else if (typeof value === 'object' && value !== null) {
      for (const [k, v] of Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))) walk(v, `${key}.${k}`);
    }
  };
  walk(spec.fields.program_requirements_json, '');
  return [
    p.name_en,
    p.name_local ?? '',
    p.field_code,
    ...modules,
    university?.fields.name_en ?? '',
    city?.fields.city_name_en ?? '',
  ]
    .map((t) => t.trim())
    .filter((t) => t !== '')
    .join(' | ');
}

export class Materializer {
  async materialize(
    store: WikiLayerStore,
    layer: WikiLayer,
    nodeKey: string,
    season: string,
  ): Promise<MaterializeResult> {
    switch (layer) {
      case 'PROGRAM_SPEC':
        return this.forProgram(store, nodeKey, season);
      case 'UNIVERSITY': {
        const uni = await store.findNode('UNIVERSITY', nodeKey);
        if (!live(uni)) return this.invalidateUniversity(store, nodeKey, season);
        return { cards: [await this.tuitionAid(store, uni, season)], evict: [], searchTexts: [] };
      }
      case 'CITY': {
        const city = await store.findNode('CITY', nodeKey);
        if (!live(city))
          return { cards: [], evict: [{ kind: 'city', nodeId: nodeKey, season }], searchTexts: [] };
        return { cards: [await this.city(store, city, season)], evict: [], searchTexts: [] };
      }
      case 'HOUSING': {
        const housing = await store.findNode('HOUSING', nodeKey);
        const uniId = nodeKey.slice(0, nodeKey.lastIndexOf(':'));
        const uni = await store.findNode('UNIVERSITY', uniId);
        if (!live(housing) || !live(uni))
          return { cards: [], evict: [{ kind: 'dorms', nodeId: uniId, season }], searchTexts: [] };
        return { cards: [await this.dorms(store, housing, uni, season)], evict: [], searchTexts: [] };
      }
      case 'COUNTRY':
      case 'ORIGIN_EQUIVALENCY':
        return { cards: [], evict: [], searchTexts: [] };
    }
  }

  private async forProgram(
    store: WikiLayerStore,
    nodeKey: string,
    season: string,
  ): Promise<MaterializeResult> {
    const spec = await store.findNode('PROGRAM_SPEC', nodeKey);
    const programId = nodeKey.slice(0, nodeKey.lastIndexOf(':'));
    const parentId = spec?.fields.program.university_id ?? programId.split(':')[0] ?? '';
    if (!live(spec)) {
      // MEDIUM-4: the docs card goes, and the university's tuition_aid card is recompiled without the programme
      const uniId = parentId;
      const uni = await store.findNode('UNIVERSITY', uniId);
      const cards = live(uni) ? [await this.tuitionAid(store, uni, season)] : [];
      return { cards, evict: [{ kind: 'docs', nodeId: programId, season }], searchTexts: [] };
    }
    const uni = await store.findNode('UNIVERSITY', spec.fields.program.university_id);
    const city = live(uni) ? await store.findNode('CITY', uni.fields.city_id) : undefined;
    const cards: SliceCard[] = [];
    if (live(uni)) {
      const docs = compileDocsCard({
        spec: spec.fields,
        university: uni.fields,
        depth: spec.depth,
        version: spec.version,
        citations: spec.citations,
      });
      await store.setCard({ kind: 'docs', rowId: spec.rowId }, docs);
      cards.push(docs, await this.tuitionAid(store, uni, season));
      const housing = (await store.listHousing(uni.fields.id)).find((h) => live(h));
      if (housing !== undefined) cards.push(await this.dorms(store, housing, uni, season));
    }
    if (live(city)) cards.push(await this.city(store, city, season));
    const text = programSearchText(spec, live(uni) ? uni : undefined, live(city) ? city : undefined);
    await store.upsertProgramSearchText(programId, text);
    return { cards, evict: [], searchTexts: [{ programId, text }] };
  }

  /**
   * MEDIUM-4: a quarantined university invalidates every card that renders its facts: its tuition_aid and dorms
   * cards and the docs card of each of its programmes (Postgres column cleared + Valkey eviction).
   */
  private async invalidateUniversity(
    store: WikiLayerStore,
    uniId: string,
    season: string,
  ): Promise<MaterializeResult> {
    const evict: CardRef[] = [
      { kind: 'tuition_aid', nodeId: uniId, season },
      { kind: 'dorms', nodeId: uniId, season },
    ];
    for (const spec of await store.listSpecs(uniId, season)) {
      await store.setCard({ kind: 'docs', rowId: spec.rowId }, null);
      evict.push({ kind: 'docs', nodeId: spec.fields.program_id, season });
    }
    for (const housing of await store.listHousing(uniId))
      await store.setCard({ kind: 'dorms', rowId: housing.rowId }, null);
    return { cards: [], evict, searchTexts: [] };
  }

  private async tuitionAid(
    store: WikiLayerStore,
    uni: StoredNode<'UNIVERSITY'>,
    season: string,
  ): Promise<SliceCard> {
    const specs = (await store.listSpecs(uni.fields.id, season)).filter(
      (s) => live(s) && s.wikiStatus === 'ACTIVE',
    );
    const card = compileTuitionAidCard({
      university: uni.fields,
      season,
      programs: specs.map((s) => ({
        id: s.fields.program_id,
        name: s.fields.program.name_en,
        tuitionAnnualEur: s.fields.tuition_annual_eur,
        scholarshipCodes: s.fields.scholarship_waiver_codes_json,
      })),
      depth: uni.depth,
      version: uni.version,
      citations: uni.citations,
    });
    await store.setCard({ kind: 'tuition_aid', rowId: uni.rowId }, card);
    return card;
  }

  private async city(store: WikiLayerStore, city: StoredNode<'CITY'>, season: string): Promise<SliceCard> {
    const card = compileCityCard({
      city: city.fields,
      season,
      depth: city.depth,
      version: city.version,
      citations: city.citations,
    });
    await store.setCard({ kind: 'city', rowId: city.rowId }, card);
    return card;
  }

  private async dorms(
    store: WikiLayerStore,
    housing: StoredNode<'HOUSING'>,
    uni: StoredNode<'UNIVERSITY'>,
    season: string,
  ): Promise<SliceCard> {
    const card = compileDormsCard({
      housing: housing.fields,
      university: uni.fields,
      season,
      depth: housing.depth,
      version: housing.version,
      citations: housing.citations,
    });
    await store.setCard({ kind: 'dorms', rowId: housing.rowId }, card);
    return card;
  }
}

/** Valkey write-through of compiled cards (ephemeral; Postgres `agent_slice_card_json` stays authoritative). */
export class SliceCardCache {
  constructor(private readonly cache: CachePort) {}

  async publish(result: Pick<MaterializeResult, 'cards' | 'evict'>): Promise<void> {
    for (const card of result.cards)
      await this.cache.set(cardCacheKey(card), JSON.stringify(card), CARD_TTL_SECONDS);
    for (const ref of result.evict)
      await this.cache.delete(cardCacheKey({ kind: ref.kind, node_id: ref.nodeId, season: ref.season }));
  }

  async get(ref: CardRef): Promise<SliceCard | undefined> {
    const raw = await this.cache.get(
      cardCacheKey({ kind: ref.kind, node_id: ref.nodeId, season: ref.season }),
    );
    return raw === undefined ? undefined : SliceCard.parse(JSON.parse(raw));
  }
}
