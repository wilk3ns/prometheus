# Prometheus — monorepo (Tranches T1 + T2)

Build spec: vault `engineering/02-active-tranche.md`. T1 = official crawler & snapshot engine; T2 = Knowledge
Wiki wiki-v2.0 (6 layers), cross-family ModelRouter + dual-pass verifier (DBOS WF-03 / WF-19), <350-token Slice
Cards, and the $0 deterministic matcher in `apps/core`.

## T2 at a glance

| Path                            | Purpose                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/ai`                   | ModelRouter (route policy, GR-AI-009 family exclusion, PII gating, atomic `econ.call_budget` reservation, ledger), untrusted-text fencing, hash-locked prompts, OpenAI / Gemini / replay adapters |
| `apps/wiki-curator/src/curator` | validators, publish gate, 404 healer, Slice Card compiler, materializer, DBOS workflows, golden importer (`golden-mapping.ts` = the only fixture interpretation)                                  |
| `apps/core`                     | `matching` module (pure L1 engine, L2 pg_trgm/pgvector, L3 boost limited to L1 results) + Hono dev server; connects ONLY as `app_core`                                                            |
| `cassettes/`                    | committed replay cassettes (`AI_MODE=replay` default: zero API keys); regenerate with `UPDATE_CASSETTES=1 pnpm test`                                                                              |
| `tests/e2e`                     | golden-record gates (6/7) and `smoke-t2.ts` (gate 9); need `PROMETHEUS_VAULT_DIR`                                                                                                                 |

```sh
pnpm test                    # unit (no infrastructure)
pnpm test:it                 # integration (stack up)
PROMETHEUS_VAULT_DIR=/abs/vault pnpm test:golden   # golden fixtures from the vault (gates 6, 7)
PROMETHEUS_VAULT_DIR=/abs/vault pnpm smoke:t2      # gate 9 end to end
pnpm --filter @prometheus/wiki-curator import-golden  --file /abs/golden.json
pnpm --filter @prometheus/wiki-curator verify-target  --target <program>:<season>
pnpm --filter @prometheus/wiki-curator build-baseline --season 2027-FALL --batch <id> --all
pnpm --filter @prometheus/core start                 # POST /api/v1/dev/match on 127.0.0.1:8787
```

T2 environment (defaults applied by `scripts/env.mjs`): `AI_MODE` (`replay` | `live`; live keys come from
`.secrets/openai_api_key` / `gemini_api_key`), `AI_CASSETTE_DIR` (`<repo>/cassettes`), `VALKEY_URL`,
`CORE_HTTP_PORT` (8787), `MATCHING_EMBEDDINGS` (`off`). `pnpm db:migrate` also provisions the DBOS system schema
`dbos` with the migrator role (runtime roles never run DDL).

## Layout

| Path                            | Purpose                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `packages/kernel`               | UUIDv7 `IdGen`, `canonicalJson`, `sha256Hex`, `ClockPort`, `Result<T,E>`, `EU27_ISO2`                 |
| `packages/config`               | Zod-validated env loader (`INFRA_PROFILE=local\|azure`)                                               |
| `packages/contracts`            | Zod 4 schemas: seed file, crawler DTOs, snapshot metadata, crawl outcomes                             |
| `packages/infra-ports`          | `BlobStorePort`, `SecretsPort`, `CachePort`, `HttpFetcherPort`, `JsRendererPort`, `PdfExtractorPort`  |
| `packages/infra-adapters/local` | MinIO/S3 blob store (conditional put-if-absent), `.secrets/` file secrets, Valkey cache               |
| `packages/infra-adapters/azure` | Azure Blob store adapter (interface-complete; composed in T8)                                         |
| `packages/db`                   | Kysely factory per DB role (`connectAs` verifies `current_user`), `withSerializable`, generated types |
| `apps/wiki-curator`             | Isolated wiki worker, connects **only** as `wiki_writer`: crawler, snapshot store, seed + crawl CLI   |
| `db/migrations`                 | dbmate migrations (T1 migration is verbatim from ENG-T1 §2)                                           |
| `db/schema.sql`                 | auto-dumped schema (incl. GRANT/REVOKE role contract), diff-checked by `pnpm db:verify`               |
| `deploy/compose`                | local stack: pgvector pg17, valkey 8, MinIO + bucket init, `fixture-sites` test server                |

## Prerequisites

Node `>=24`, pnpm 12, Docker (Compose v2). Then:

```sh
pnpm install
node apps/wiki-curator/node_modules/playwright/cli.js install chromium-headless-shell   # Tier 2 browser
pnpm secrets:init-local     # writes dev-only .secrets/{wiki_writer_db_password,app_core_db_password,s3_secret_access_key}
pnpm stack:up               # docker compose up -d --wait (zero cloud credentials)
pnpm db:migrate             # dbmate up + dump db/schema.sql + regenerate Kysely types
```

## Environment

There is no `.env` file. Repo tooling (`db:*`, `test:it`, `smoke:t1`, the curator `seed`/`crawl` package
scripts) fills **unset** variables from `scripts/env.mjs` `LOCAL_DEFAULTS`, which mirror the compose stack, and
refuses to do so when `INFRA_PROFILE` is not `local`. Override any of them in your shell.

| Variable                                                                           | Default (local)                                           | Notes                                                                                                                                 |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `INFRA_PROFILE`                                                                    | `local`                                                   | `azure` is validated but not composable before T8                                                                                     |
| `PG_HOST` / `PG_PORT` / `PG_DATABASE`                                              | `localhost` / `5432` / `prometheus`                       |                                                                                                                                       |
| `PG_ADMIN_USER` / `PG_ADMIN_PASSWORD`                                              | `postgres` / `postgres_dev`                               | tooling only (migrations, codegen, IT reset)                                                                                          |
| `S3_ENDPOINT` / `S3_REGION` / `S3_ACCESS_KEY_ID`                                   | `http://localhost:9000` / `eu-central-1` / `minio-dev`    | secret key comes from `.secrets/s3_secret_access_key`                                                                                 |
| `WIKI_SNAPSHOT_BUCKET`                                                             | `wiki-snapshots`                                          |                                                                                                                                       |
| `SECRETS_DIR`                                                                      | `<repo>/.secrets`                                         | must be absolute                                                                                                                      |
| `VALKEY_URL`                                                                       | `redis://localhost:6379`                                  |                                                                                                                                       |
| `FIXTURE_CANARY_ORIGIN`                                                            | `http://localhost:8089`                                   | raw TCP+UDP egress canary used by the escape ITs                                                                                      |
| `FIXTURE_SITES_ORIGIN`                                                             | `http://localhost:8088`                                   |                                                                                                                                       |
| `ALLOW_LOCAL_FIXTURE_HOSTS`                                                        | `false`                                                   | `true` exempts ONLY the `LOCAL_FIXTURE_HOSTS` hostnames from the private-IP block and the default-port rule; rejected outside `local` |
| `LOCAL_FIXTURE_HOSTS`                                                              | `localhost`                                               | comma-separated fixture hostnames for the exemption above; IP literals and every other host stay strict (live crawls included)        |
| `CRAWLER_USER_AGENT`                                                               | `PrometheusWikiCurator/0.1 (official-source snapshotter)` | honest UA for both tiers                                                                                                              |
| `PROMETHEUS_VAULT_DIR`                                                             | —                                                         | absolute vault path; `smoke:t1` reads `engineering/fixtures/seed-5country-targets.json` from it                                       |
| `LIVE_CRAWL`                                                                       | `0`                                                       | `1` adds a bounded live crawl (3 pages) to `smoke:t1`; informational, never a gate                                                    |
| `PG_PORT`, `VALKEY_PORT`, `MINIO_PORT`, `MINIO_CONSOLE_PORT`, `FIXTURE_SITES_PORT` | 5432/6379/9000/9001/8088                                  | compose host ports, if occupied                                                                                                       |

## Commands

```sh
pnpm build && pnpm typecheck && pnpm lint     # tsc, ESLint (type-aware), dependency-cruiser, Prettier
pnpm db:migrate | db:rollback | db:verify     # verify: up/down/up on a scratch DB; schema.sql + types must match
pnpm test                                     # unit tests (no infrastructure)
pnpm test:it                                  # integration tests: needs `pnpm stack:up`; resets <PG_DATABASE>_it
PROMETHEUS_VAULT_DIR=/abs/path/to/vault pnpm smoke:t1     # exit gate 8

pnpm --filter @prometheus/wiki-curator seed  --file /abs/path/seed-5country-targets.json
pnpm --filter @prometheus/wiki-curator crawl --target polimi:msc-cse:2027-FALL      # or --all
```

Tests are tagged with the T1 exit gate they prove (`[T1-G3]` ... `[T1-G8]`).

## Crawler behaviour (ENG-T1 §3)

- **Single guarded egress** (`crawler/guarded-http.ts`): every network request of both tiers is one guarded hop:
  allowlist pre-check (documents) and resolved-address pre-check (private, loopback, link-local, CGNAT,
  multicast, reserved, test nets; IPv6 6to4 / NAT64 / IPv4-translated / Teredo / IPv4-compatible blocked
  outright, IPv4-mapped decoded), re-checked at socket connect time (DNS-rebinding defence), 15 MB cap on raw
  and decoded bytes, caller-owned deadline. Only default ports 80/443 (fixture hosts excepted locally).
- **Tier 1** (undici): redirects followed hop by hop through the guard; one 15 s deadline over all hops + body.
  PDFs (content-type or `%PDF-` magic) go to pdf.js, never Playwright. 404/410 -> `MISSING_SOURCE_404` row.
  Escalate to Tier 2 iff host is `JS_CATALOG` or Tier 1 clean text < 500 chars.
- **Tier 2** (Playwright Chromium), three independent containment layers (`crawler/browser-hardening.ts`):
  1. `context.route` serves every request of every page through the guarded client; documents (main frame +
     iframes) must be allowlisted, sub-resources must be public; main-frame redirects are re-navigated after a
     guard check; popups are closed; `routeWebSocket` closes every WebSocket before it connects;
  2. an init script removes WebRTC (`RTCPeerConnection`, `webkitRTCPeerConnection`, `RTCDataChannel`, ...),
     `WebTransport` and `WebSocketStream` from every frame before page scripts run;
  3. Chromium's only proxy is a local fail-closed black hole (`crawler/egress-blackhole.ts`, implicit loopback
     bypass removed), with QUIC, non-proxied WebRTC UDP, DNS prefetch and background networking disabled, so
     anything that still dials out (e.g. from a worker) reaches nothing.

  Per render: `domcontentloaded` + `networkidle` (cap 10 s), one 25 s deadline, at most 250 requests and 50 MB
  in total (`RENDER_BUDGET_EXCEEDED`), and rendered HTML capped at 15 MB. No stealth plugins, no CAPTCHA
  solving: challenge gates become `WAF_CHALLENGE_DETECTED`.

- **Local fixture exemption** is host-scoped (`LOCAL_FIXTURE_HOSTS`) and context-scoped: it applies only to the
  crawl target's own requests (Tier 1, and the requests of a page whose own host is a fixture host), never to
  sub-resources of any other page. So `LIVE_CRAWL=1` pages cannot reach local services.
- **Resilience:** an error while capturing one URL becomes `NOT_FETCHED / CAPTURE_FAILED` and the crawl goes on;
  `crawl --all` isolates per target (`TARGET_FAILED`, exit 1 at the end). HTML and PDF extraction run in a fresh
  worker thread (`crawler/extraction-sandbox.ts`) with a heap limit and a hard wall-clock limit enforced by
  `worker.terminate()`: 20 s for HTML, 60 s for PDF, failing as `EXTRACTION_FAILED`. DOM nesting beyond 256
  levels is flattened to text, and PDFs above 2,000 pages are refused.
- HTML extraction never assumes `<main>`; strips chrome; data tables become pipe-delimited Markdown.
- Links: all allowlisted `href`s (local-language paths included), normalised (no `#fragment`, no `utm_*`),
  never synthesised. BFS order comes from the `LinkSelectorPort` (deterministic keyword scorer in T1); the runner
  only accepts selector output that was actually harvested.
- Snapshots are content-addressed in `wiki-snapshots`: `raw/<sha256>.(html|pdf)` (stored with the original
  `Content-Type`, so the source charset is preserved), `text/<sha256>.txt`; existing objects are never
  re-uploaded, each fetch still records a `wiki.source_snapshot` row.
- `smoke:t1` crawls a per-run nonce page (run #1 must write new blobs, run #2 must reuse them) and deactivates
  its fixture target afterwards.
