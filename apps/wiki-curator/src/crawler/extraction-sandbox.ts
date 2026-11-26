import { Worker, type ResourceLimits } from 'node:worker_threads';
import {
  HtmlExtractionError,
  PdfExtractionError,
  type HtmlExtraction,
  type HtmlExtractorPort,
  type PdfExtractorPort,
  type PdfText,
} from '@prometheus/infra-ports';
import type { DomainAllowlist } from './allowlist.js';
import type { ExtractionReply, ExtractionTask } from './extraction-worker.js';
import { DiscoveredLink } from '@prometheus/contracts';
import { z } from 'zod';
import { CRAWL_POLICY } from './policy.js';

/** Replies cross a thread boundary: validated, never cast. */
const HtmlExtractionReply = z.object({
  cleanText: z.string(),
  cleanCharCount: z.int().min(0),
  links: z.array(DiscoveredLink),
  lang: z.string().nullable(),
});
const PdfTextReply = z.object({ pageCount: z.int().min(0), pages: z.array(z.string()) });

/**
 * Extraction sandbox: every HTML / PDF extraction runs in a fresh worker thread with a heap limit and a
 * HARD wall-clock limit enforced by `worker.terminate()`. Parsing (htmlparser2, pdf.js) is synchronous,
 * CPU-bound and not preemptible in-process; a thread can be killed mid-instruction, so one hostile page
 * (e.g. 1M nested elements, a pathological PDF) costs at most the limit, and the crawl moves on.
 * The extractors themselves stay pure modules; this is only an execution wrapper.
 */

export type SandboxFailure = { readonly kind: 'TIMEOUT' | 'CRASHED' | 'FAILED'; readonly detail: string };

export interface SandboxOptions {
  /** Worker entry (default: the compiled sibling `extraction-worker.js`). */
  readonly workerUrl?: URL;
  /** Extra node flags for the worker (tests use them to run the TypeScript sources). */
  readonly execArgv?: readonly string[];
  readonly resourceLimits?: ResourceLimits;
}

const DEFAULT_LIMITS: ResourceLimits = {
  maxOldGenerationSizeMb: 768,
  maxYoungGenerationSizeMb: 64,
  stackSizeMb: 8,
};

export class ExtractionSandbox {
  private readonly workerUrl: URL;
  private readonly execArgv: readonly string[];
  private readonly resourceLimits: ResourceLimits;

  constructor(options: SandboxOptions = {}) {
    this.workerUrl = options.workerUrl ?? new URL('./extraction-worker.js', import.meta.url);
    this.execArgv = options.execArgv ?? [];
    this.resourceLimits = options.resourceLimits ?? DEFAULT_LIMITS;
  }

  run(
    task: ExtractionTask,
    timeoutMs: number,
  ): Promise<{ ok: true; value: unknown } | { ok: false; failure: SandboxFailure }> {
    return new Promise((resolve) => {
      const worker = new Worker(this.workerUrl, {
        workerData: task,
        execArgv: [...this.execArgv],
        resourceLimits: this.resourceLimits,
        stdout: false,
        stderr: false,
      });
      let settled = false;
      const settle = (
        result: { ok: true; value: unknown } | { ok: false; failure: SandboxFailure },
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Always tear the thread down: on success, on failure, and (above all) on timeout.
        void worker.terminate();
        resolve(result);
      };
      const timer = setTimeout(
        () =>
          settle({
            ok: false,
            failure: { kind: 'TIMEOUT', detail: `extraction exceeded ${timeoutMs} ms (worker terminated)` },
          }),
        timeoutMs,
      );
      worker.once('message', (reply: ExtractionReply) => {
        if (reply.ok) settle({ ok: true, value: reply.value });
        else settle({ ok: false, failure: { kind: 'FAILED', detail: `${reply.name}: ${reply.message}` } });
      });
      worker.once('error', (error: Error) =>
        settle({ ok: false, failure: { kind: 'CRASHED', detail: `${error.name}: ${error.message}` } }),
      );
      worker.once('exit', (code) =>
        settle({
          ok: false,
          failure: { kind: 'CRASHED', detail: `extraction worker exited with code ${code}` },
        }),
      );
    });
  }
}

/** HtmlExtractorPort running `extractHtml` in the sandbox. */
export class SandboxedHtmlExtractor implements HtmlExtractorPort {
  constructor(
    private readonly sandbox: ExtractionSandbox,
    private readonly allowlist: DomainAllowlist,
    private readonly timeoutMs: number = CRAWL_POLICY.htmlExtractionTimeoutMs,
  ) {}

  async extract(
    html: string,
    finalUrl: string,
    contentLanguage: string | undefined,
  ): Promise<HtmlExtraction> {
    const result = await this.sandbox.run(
      { kind: 'html', html, finalUrl, contentLanguage, allowlist: this.allowlist.snapshot() },
      this.timeoutMs,
    );
    if (!result.ok)
      throw new HtmlExtractionError(`HTML extraction ${result.failure.kind}: ${result.failure.detail}`);
    const parsed = HtmlExtractionReply.safeParse(result.value);
    if (!parsed.success) throw new HtmlExtractionError('HTML extraction worker returned a malformed result');
    return parsed.data;
  }
}

/** PdfExtractorPort running pdf.js in the sandbox. */
export class SandboxedPdfExtractor implements PdfExtractorPort {
  constructor(
    private readonly sandbox: ExtractionSandbox,
    private readonly limits: { readonly maxPages?: number; readonly timeoutMs?: number } = {},
  ) {}

  async extract(bytes: Uint8Array): Promise<PdfText> {
    const result = await this.sandbox.run(
      { kind: 'pdf', bytes, maxPages: this.limits.maxPages ?? CRAWL_POLICY.pdfMaxPages },
      this.limits.timeoutMs ?? CRAWL_POLICY.pdfTimeoutMs,
    );
    if (!result.ok)
      throw new PdfExtractionError(`PDF extraction ${result.failure.kind}: ${result.failure.detail}`);
    const parsed = PdfTextReply.safeParse(result.value);
    if (!parsed.success) throw new PdfExtractionError('PDF extraction worker returned a malformed result');
    return parsed.data;
  }
}
