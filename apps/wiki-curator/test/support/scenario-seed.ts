import { DestinationCountry } from '@prometheus/contracts';
import { blobRef } from '@prometheus/infra-ports';
import { sha256Hex } from '@prometheus/kernel';
import type { CuratorRuntime, WikiServices } from '../../src/bootstrap.js';
import { CITY_ID, UNIVERSITY_ID, type Scenario } from './curator-scenarios.js';

/**
 * Idempotent seeding of the synthetic WF-03 scenario world (official allowlist host, crawl target, stored
 * snapshot + text blob, BASELINE university / city / housing context). Shared by curator-verify.it.ts and
 * `pnpm smoke:t2`; safe to run repeatedly against the same database.
 */
export async function seedScenarioContext(runtime: CuratorRuntime, services: WikiServices): Promise<void> {
  await runtime.repo.upsertSeed(
    [
      {
        host: 'pw.edu.pl',
        country_iso2: 'PL',
        org_kind: 'UNIVERSITY',
        allow_subdomains: true,
        default_fetch_mode: 'HTTP_FIRST',
      },
    ],
    [],
  );
  const base = {
    score: null,
    citations: [],
    slotCompleteness: {},
    lockedPaths: [],
    expectedVersion: 0,
    actor: 'HUMAN' as const,
    reason: 'synthetic WF-03 scenario context',
    verifiedAt: new Date(),
    evidenceBasis: 'VERIFIED_CITATIONS' as const,
    depth: 'BASELINE' as const,
    wikiStatus: null,
  };
  if ((await services.layers.findNode('CITY', CITY_ID)) === undefined) {
    await services.layers.writeNode({
      ...base,
      layer: 'CITY',
      nodeKey: CITY_ID,
      fields: {
        id: CITY_ID,
        country_iso2: 'PL',
        city_name_en: 'T2 City',
        monthly_living_min_eur: 700,
        monthly_living_max_eur: 1100,
        minor_consents_json: [],
        attributes_json: { transport: 'tram' },
      },
    });
  }
  if ((await services.layers.findNode('UNIVERSITY', UNIVERSITY_ID)) === undefined) {
    await services.layers.writeNode({
      ...base,
      layer: 'UNIVERSITY',
      nodeKey: UNIVERSITY_ID,
      fields: {
        id: UNIVERSITY_ID,
        name_en: 'T2 Verify University of Technology',
        name_local: null,
        country_iso2: 'PL',
        city_id: CITY_ID,
        institution_type: 'PUBLIC',
        official_domain: 'pw.edu.pl',
        official_email_domains_json: ['pw.edu.pl'],
        primary_portal_type: 'IRK',
        portal_url: null,
        sends_email_notifications: true,
        credit_card_accepted: false,
        pricing_tier_code: 'T2',
        minor_consents_json: [],
        general_rules_json: { refunds: 'visa refusal only' },
      },
    });
  }
  if ((await services.layers.findNode('HOUSING', `${UNIVERSITY_ID}:2026-2027`)) === undefined) {
    await services.layers.writeNode({
      ...base,
      layer: 'HOUSING',
      nodeKey: `${UNIVERSITY_ID}:2026-2027`,
      fields: {
        university_id: UNIVERSITY_ID,
        rates_season: '2026-2027',
        portal_url: null,
        official_info_url: 'https://www.pw.edu.pl/t2verify/dorms',
        rate_pdf_url: null,
        total_places: 300,
        subsidized_places: null,
        monthly_min_eur: 120,
        monthly_max_eur: 300,
        non_refundable_on_visa_denial: true,
        critical_rules_json: { deposit_pln: 500 },
        halls_json: [{ name: 'Hall A' }],
      },
    });
  }
}

export async function seedScenarioSnapshot(runtime: CuratorRuntime, s: Scenario): Promise<void> {
  await runtime.repo.upsertSeed(
    [],
    [
      {
        id: runtime.ids.next(),
        target_key: s.targetKey,
        country_iso2: DestinationCountry.parse(s.countryIso2),
        layer_hint: s.layer === 'PROGRAM_SPEC' ? 'PROGRAM' : s.layer,
        max_depth: 0,
        max_pages: 1,
        seed_urls: [s.url],
      },
    ],
  );
  const target = await runtime.repo.findTargetByKey(s.targetKey);
  if (!target) throw new Error(`target ${s.targetKey} missing after seed`);
  const exists = await runtime.db
    .selectFrom('wiki.source_snapshot')
    .select('id')
    .where('id', '=', s.snapshotId)
    .executeTakeFirst();
  if (exists !== undefined) return;
  const bytes = Buffer.from(s.text, 'utf8');
  const sha = sha256Hex(bytes);
  await runtime.blobs.putIfAbsent(`raw/${sha}.html`, bytes, 'text/html; charset=utf-8');
  await runtime.blobs.putIfAbsent(`text/${sha}.txt`, bytes, 'text/plain; charset=utf-8');
  await runtime.repo.insertSnapshot({
    id: s.snapshotId,
    target_id: target.id,
    requested_url: s.url,
    final_url: s.url,
    host: new URL(s.url).hostname,
    http_status: 200,
    fetch_tier: 'TIER1_HTTP',
    content_kind: 'HTML',
    detected_lang: 'en',
    raw_sha256: sha,
    raw_blob_ref: blobRef(runtime.blobs, `raw/${sha}.html`),
    clean_text_sha256: sha,
    clean_text_blob_ref: blobRef(runtime.blobs, `text/${sha}.txt`),
    clean_char_count: s.text.length,
    page_count: null,
    discovered_links: [],
    error_code: null,
    fetched_at: s.fetchedAt,
  });
}
