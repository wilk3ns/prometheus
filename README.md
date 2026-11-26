# Prometheus — monorepo (Tranche T1: core + 2-tier official crawler & snapshot engine)

Build spec: vault `engineering/02-active-tranche.md` (ENG-T1). Only T1 is implemented here.

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
- **Tier 2** (Playwright Chromium): `context.route` serves every request of every page through the guarded
  client, so Chromium never opens a connection itself. Documents (main frame + iframes) must be allowlisted;
  sub-resources may be third-party public hosts, never non-public. Main-frame redirects are re-navigated
  after a guard check. Popups are closed, WebSockets closed before server contact, image/media/font + trackers
  aborted, service workers / downloads / non-proxied WebRTC / DNS prefetch disabled. `domcontentloaded` +
  `networkidle` (cap 10 s), one 25 s render deadline, rendered HTML capped at 15 MB. No stealth plugins, no
  CAPTCHA solving: challenge gates -> `WAF_CHALLENGE_DETECTED`.
- **Resilience:** an error while capturing one URL becomes `NOT_FETCHED / CAPTURE_FAILED` and the crawl goes on;
  `crawl --all` isolates per target (`TARGET_FAILED`, exit 1 at the end). DOM nesting beyond 256 levels is
  flattened to text (stack-safe on hostile pages); pdf.js is bounded to 2,000 pages and 60 s
  (`EXTRACTION_FAILED`).
- HTML extraction never assumes `<main>`; strips chrome; data tables become pipe-delimited Markdown.
- Links: all allowlisted `href`s (local-language paths included), normalised (no `#fragment`, no `utm_*`),
  never synthesised. BFS order comes from the `LinkSelectorPort` (deterministic keyword scorer in T1); the runner
  only accepts selector output that was actually harvested.
- Snapshots are content-addressed in `wiki-snapshots`: `raw/<sha256>.(html|pdf)` (stored with the original
  `Content-Type`, so the source charset is preserved), `text/<sha256>.txt`; existing objects are never
  re-uploaded, each fetch still records a `wiki.source_snapshot` row.
- `smoke:t1` crawls a per-run nonce page (run #1 must write new blobs, run #2 must reuse them) and deactivates
  its fixture target afterwards.
