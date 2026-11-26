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

| Variable                                                                           | Default (local)                                           | Notes                                                                                           |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `INFRA_PROFILE`                                                                    | `local`                                                   | `azure` is validated but not composable before T8                                               |
| `PG_HOST` / `PG_PORT` / `PG_DATABASE`                                              | `localhost` / `5432` / `prometheus`                       |                                                                                                 |
| `PG_ADMIN_USER` / `PG_ADMIN_PASSWORD`                                              | `postgres` / `postgres_dev`                               | tooling only (migrations, codegen, IT reset)                                                    |
| `S3_ENDPOINT` / `S3_REGION` / `S3_ACCESS_KEY_ID`                                   | `http://localhost:9000` / `eu-central-1` / `minio-dev`    | secret key comes from `.secrets/s3_secret_access_key`                                           |
| `WIKI_SNAPSHOT_BUCKET`                                                             | `wiki-snapshots`                                          |                                                                                                 |
| `SECRETS_DIR`                                                                      | `<repo>/.secrets`                                         | must be absolute                                                                                |
| `VALKEY_URL`                                                                       | `redis://localhost:6379`                                  |                                                                                                 |
| `FIXTURE_SITES_ORIGIN`                                                             | `http://localhost:8088`                                   |                                                                                                 |
| `ALLOW_LOCAL_FIXTURE_HOSTS`                                                        | `false`                                                   | `true` lets the crawler reach loopback/private IPs; rejected outside `local`                    |
| `CRAWLER_USER_AGENT`                                                               | `PrometheusWikiCurator/0.1 (official-source snapshotter)` | honest UA for both tiers                                                                        |
| `PROMETHEUS_VAULT_DIR`                                                             | —                                                         | absolute vault path; `smoke:t1` reads `engineering/fixtures/seed-5country-targets.json` from it |
| `LIVE_CRAWL`                                                                       | `0`                                                       | `1` adds a bounded live crawl (3 pages) to `smoke:t1`; informational, never a gate              |
| `PG_PORT`, `VALKEY_PORT`, `MINIO_PORT`, `MINIO_CONSOLE_PORT`, `FIXTURE_SITES_PORT` | 5432/6379/9000/9001/8088                                  | compose host ports, if occupied                                                                 |

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

- Every request **and every redirect hop** (Tier 1 manual redirects; Tier 2 main-frame navigations) is checked
  against `wiki.official_domain_allowlist` and against the **resolved** IP addresses (private, loopback,
  link-local, CGNAT, multicast, reserved; IPv4-mapped IPv6 normalised). Tier 1 re-checks addresses at socket
  connect time (DNS-rebinding defence). Off-allowlist redirect -> `DISALLOWED_REDIRECT`, 0 bytes stored.
- Tier 1 (undici, 15 s, 15 MB streamed cap incl. decompressed size). PDFs (content-type or `%PDF-` magic) go to
  pdf.js, never Playwright. 404/410 -> `MISSING_SOURCE_404` row. Escalate to Tier 2 iff host is `JS_CATALOG` or
  Tier 1 clean text < 500 chars. Tier 2 blocks image/media/font + trackers, waits `domcontentloaded` +
  `networkidle` (cap 10 s). No stealth plugins, no CAPTCHA solving: challenge gates -> `WAF_CHALLENGE_DETECTED`.
- HTML extraction never assumes `<main>`; strips chrome; data tables become pipe-delimited Markdown.
- Links: all allowlisted `href`s (local-language paths included), normalised (no `#fragment`, no `utm_*`),
  never synthesised. BFS order comes from the `LinkSelectorPort` (deterministic keyword scorer in T1); the runner
  only accepts selector output that was actually harvested.
- Snapshots are content-addressed in `wiki-snapshots`: `raw/<sha256>.(html|pdf)`, `text/<sha256>.txt`;
  existing objects are never re-uploaded, each fetch still records a `wiki.source_snapshot` row.
