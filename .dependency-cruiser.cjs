/**
 * Module-boundary and vendor-SDK allowlist (ENG-T1 §1). `pnpm lint:deps` fails on any violation.
 *
 * Layering (allowed direction ->):
 *   kernel <- contracts <- infra-ports <- infra-adapters
 *   kernel, contracts, config, db, infra-ports, infra-adapters <- apps/*
 * Vendor SDKs are confined to the single adapter file that wraps them.
 */
const VENDOR_OWNERS = [
  {
    sdk: 'undici',
    path: '(^|/)node_modules/undici/',
    owner: '^apps/wiki-curator/src/crawler/tier1-http[.]ts$',
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
    owner: '^(packages/db/(src|test)/|apps/wiki-curator/src/persistence/|apps/wiki-curator/test/)',
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
      comment: 'crawler modules depend on ports; only bootstrap.ts (composition root) picks adapters',
      severity: 'error',
      from: { path: '^apps/wiki-curator/src/(crawler|seed|persistence)/' },
      to: { path: '^packages/infra-adapters/' },
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
