import { parentPort, workerData } from 'node:worker_threads';
import { DomainAllowlist, type AllowlistSnapshot } from './allowlist.js';
import { extractHtml } from './html-extractor.js';
import { PdfjsTextExtractor } from './pdf-extractor.js';

/**
 * Worker-thread entry for the extraction sandbox: runs ONE pure extraction task and posts the result.
 * It holds no logic of its own; all behaviour lives in html-extractor.ts / pdf-extractor.ts. Being a
 * separate thread, it can be terminated at any instant (hard wall-clock limit) and has its own heap limit.
 */

export type ExtractionTask =
  | {
      readonly kind: 'html';
      readonly html: string;
      readonly finalUrl: string;
      readonly contentLanguage: string | undefined;
      readonly allowlist: AllowlistSnapshot;
    }
  | { readonly kind: 'pdf'; readonly bytes: Uint8Array; readonly maxPages: number };

export type ExtractionReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly name: string; readonly message: string };

async function run(task: ExtractionTask): Promise<unknown> {
  if (task.kind === 'html') {
    return extractHtml(
      task.html,
      task.finalUrl,
      DomainAllowlist.fromSnapshot(task.allowlist),
      task.contentLanguage,
    );
  }
  return new PdfjsTextExtractor({ maxPages: task.maxPages }).extract(task.bytes);
}

if (parentPort === null) throw new Error('extraction-worker must run as a worker thread');
const port = parentPort;
// workerData is produced solely by ExtractionSandbox.run(task: ExtractionTask) in the parent thread.
run(workerData as ExtractionTask).then(
  (value) => port.postMessage({ ok: true, value } satisfies ExtractionReply),
  (error: unknown) =>
    port.postMessage({
      ok: false,
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    } satisfies ExtractionReply),
);
