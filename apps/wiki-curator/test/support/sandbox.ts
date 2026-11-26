import { ExtractionSandbox, type SandboxOptions } from '../../src/crawler/extraction-sandbox.js';

/**
 * Extraction sandbox for tests: runs the TypeScript worker source directly (tsx loader + the workspace
 * `@prometheus/source` export condition), so tests never depend on a stale `dist/` build. Production uses
 * the default compiled sibling `extraction-worker.js` with no loader.
 */
export const TEST_WORKER_URL = new URL('../../src/crawler/extraction-worker.ts', import.meta.url);
/** Absolute loader URL: workers resolve `--import` from the process cwd (repo root), not this package. */
export const TEST_WORKER_EXEC_ARGV: readonly string[] = [
  '--conditions=@prometheus/source',
  '--import',
  import.meta.resolve('tsx'),
];

export function testSandbox(resourceLimits?: SandboxOptions['resourceLimits']): ExtractionSandbox {
  return new ExtractionSandbox({
    workerUrl: TEST_WORKER_URL,
    execArgv: TEST_WORKER_EXEC_ARGV,
    ...(resourceLimits === undefined ? {} : { resourceLimits }),
  });
}
