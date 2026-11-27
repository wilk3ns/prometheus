/**
 * Module-boundary and vendor-SDK allowlist (ENG-T1 §1). `pnpm lint:deps` fails on any violation.
 *
 * Layering (allowed direction ->):
 *   kernel <- contracts <- infra-ports <- infra-adapters
 *   kernel, contracts, db, infra-ports <- ai (ModelRouter; vendor SDKs only in packages/ai/src/adapters)
 *   kernel, contracts, config, db, infra-ports, infra-adapters, ai <- apps/*
 *   apps/core never imports apps/wiki-curator (the single Wiki writer) and vice versa (ENG-T2 Gate 1).
 * Vendor SDKs are confined to the single adapter file that wraps them.
 */
const VENDOR_OWNERS = [
  {
    sdk: 'undici',
    path: '(^|/)node_modules/undici/',
    owner: '^apps/wiki-curator/src/crawler/guarded-http[.]ts$',
  },
  {
    sdk: 'playwright',
    path: '(^|/)node_modules/playwright(-core)?/',
    owner: '^apps/wiki-curator/src/crawler/tier2-playwright[.]ts$',
  },
  {
    sdk: 'pdfjs-dist',
    path: '(^|/)node_modules/pdfjs-dist/',
    owner: '^apps/wiki-curator/src/crawler/pdf-extractor[.]ts$',
  },
  {
    sdk: 'htmlparser2/domhandler',
    path: '(^|/)node_modules/(htmlparser2|domhandler)/',
    owner: '^apps/wiki-curator/src/crawler/html-extractor[.]ts$',
  },
  {
    sdk: '@aws-sdk',
    path: '(^|/)node_modules/@aws-sdk/',
    owner: '^packages/infra-adapters/local/s3-blob-store[.]ts$',
  },
  {
    sdk: 'iovalkey',
    path: '(^|/)node_modules/iovalkey/',
    owner: '^packages/infra-adapters/local/valkey-cache[.]ts$',
  },
  { sdk: '@azure', path: '(^|/)node_modules/@azure/', owner: '^packages/infra-adapters/azure/' },
  { sdk: 'pg', path: '(^|/)node_modules/pg/', owner: '^packages/db/src/factory[.]ts$' },
  {
    sdk: 'kysely',
    path: '(^|/)node_modules/kysely/',
    owner:
      '^(packages/db/(src|test)/|packages/ai/src/econ/kysely-|packages/ai/test/|apps/wiki-curator/src/persistence/|apps/wiki-curator/test/|apps/core/src/modules/[^/]+/infra/|apps/core/test/)',
  },
  { sdk: 'openai', path: '(^|/)node_modules/openai/', owner: '^packages/ai/src/adapters/openai[.]ts$' },
  {
    sdk: '@google/genai',
    path: '(^|/)node_modules/@google/genai/',
    owner: '^packages/ai/src/adapters/gemini[.]ts$',
  },
  {
    sdk: '@dbos-inc',
    path: '(^|/)node_modules/@dbos-inc/',
    owner: '^apps/wiki-curator/src/curator/(workflows|durable)[.]ts$',
  },
  {
    sdk: 'hono',
    path: '(^|/)node_modules/(hono|@hono)/',
    owner: '^apps/core/(src/(http/app|server)[.]ts|test/)',
  },
];

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    ...VENDOR_OWNERS.map(({ sdk, path, owner }) => ({
      name: `vendor-sdk-confined:${sdk}`,
      comment: `${sdk} may only be imported by its adapter (${owner})`,
      severity: 'error',
      from: { pathNot: owner },
      to: { path },
    })),
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'kernel-is-leaf',
      comment: 'kernel depends on nothing in the workspace',
      severity: 'error',
      from: { path: '^packages/kernel/' },
      to: { path: '^(packages|apps)/', pathNot: '^packages/kernel/' },
    },
    {
      name: 'contracts-only-kernel',
      severity: 'error',
      from: { path: '^packages/contracts/' },
      to: { path: '^(packages|apps)/', pathNot: '^packages/(contracts|kernel)/' },
    },
    {
      name: 'ports-are-pure',
      comment: 'infra-ports holds interfaces only: no adapters, db or apps',
      severity: 'error',
      from: { path: '^packages/infra-ports/' },
      to: { path: '^(packages|apps)/', pathNot: '^packages/(infra-ports|contracts|kernel)/' },
    },
    {
      name: 'adapters-implement-ports-only',
      severity: 'error',
      from: { path: '^packages/infra-adapters/' },
      to: { path: '^(packages|apps)/', pathNot: '^packages/(infra-adapters|infra-ports|contracts|kernel)/' },
    },
    {
      name: 'azure-and-local-adapters-isolated',
      comment: 'prod images exclude infra-adapters/local/**: azure must never import local',
      severity: 'error',
      from: { path: '^packages/infra-adapters/azure/' },
      to: { path: '^packages/infra-adapters/local/' },
    },
    {
      name: 'packages-never-import-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'crawler-core-stays-off-adapters',
      comment: 'crawler/curator modules depend on ports; only bootstrap.ts (composition root) picks adapters',
      severity: 'error',
      from: { path: '^apps/wiki-curator/src/(crawler|curator|seed|persistence)/' },
      to: { path: '^packages/infra-adapters/' },
    },
    {
      name: 'curator-uses-repository-ports',
      comment: 'curator code talks to repository ports, never to Kysely implementations',
      severity: 'error',
      from: { path: '^apps/wiki-curator/src/curator/' },
      to: { path: '^apps/wiki-curator/src/persistence/kysely-' },
    },
    {
      name: 'core-never-imports-curator',
      comment: 'apps/core (app_core, SELECT-only on wiki.*) cannot reach the wiki_writer app or its adapters',
      severity: 'error',
      from: { path: '^apps/core/' },
      to: { path: '^apps/wiki-curator/' },
    },
    {
      name: 'curator-never-imports-core',
      severity: 'error',
      from: { path: '^apps/wiki-curator/' },
      to: { path: '^apps/core/' },
    },
    {
      name: 'core-modules-via-index',
      comment: 'outside a module, only its public modules/<m>/index.ts may be imported (ENG-01 §1)',
      severity: 'error',
      from: { path: '^apps/core/src/', pathNot: '^apps/core/src/modules/' },
      to: { path: '^apps/core/src/modules/[^/]+/', pathNot: '^apps/core/src/modules/[^/]+/index[.]ts$' },
    },
    {
      name: 'matching-domain-is-pure',
      comment: 'the $0 L1 engine has zero I/O: domain code imports only contracts, kernel and its own domain',
      severity: 'error',
      from: { path: '^apps/core/src/modules/[^/]+/domain/' },
      to: {
        path: '^(packages|apps)/|(^|/)node_modules/',
        pathNot: '^(packages/(contracts|kernel)/|apps/core/src/modules/[^/]+/domain/)|(^|/)node_modules/zod/',
      },
    },
    {
      name: 'ai-package-boundaries',
      comment: 'packages/ai depends only on kernel, contracts, db and infra-ports',
      severity: 'error',
      from: { path: '^packages/ai/' },
      to: { path: '^(packages|apps)/', pathNot: '^packages/(ai|kernel|contracts|db|infra-ports)/' },
    },
    {
      name: 'crawler-uses-repository-port',
      comment: 'crawler code talks to the WikiRepository port, never to the Kysely implementation',
      severity: 'error',
      from: { path: '^apps/wiki-curator/src/crawler/' },
      to: { path: '^apps/wiki-curator/src/persistence/kysely-' },
    },
    {
      name: 'no-test-imports-in-src',
      severity: 'error',
      from: { path: '/src/' },
      to: { path: '/test/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|\\.turbo)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['@prometheus/source', 'import', 'types', 'default'],
      extensions: ['.ts', '.js', '.mjs', '.json'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
