/** Fixed crawler limits from ENG-T1 §3 (not tunable at runtime: they are part of the tranche contract). */
export const CRAWL_POLICY = {
  /** Tier 1 total budget per URL including redirects and body download. */
  tier1TimeoutMs: 15_000,
  /** Hard cap on any response body (streamed; aborts beyond). */
  maxBodyBytes: 15 * 1024 * 1024,
  /** Hard cap on the clean text an extraction worker may return (UTF-8 bytes; ENG-T2 §0 Q5). */
  maxCleanTextBytes: 15 * 1024 * 1024,
  /** Tier 1 HTML with fewer clean characters than this escalates to Tier 2. */
  minTier1CleanChars: 500,
  maxRedirects: 10,
  acceptLanguage: 'en-US,en;q=0.9,*;q=0.8',
  /** Tier 2: `domcontentloaded` navigation budget, then `networkidle` capped at 10 s. */
  tier2NavigationTimeoutMs: 15_000,
  tier2NetworkIdleCapMs: 10_000,
  /** Tier 2: one wall-clock budget per render (navigation hops + networkidle + serialisation). */
  tier2RenderDeadlineMs: 25_000,
  /** Tier 2 per-render aggregate budgets across the document and all sub-resources. */
  tier2MaxRequestsPerRender: 250,
  tier2MaxBytesPerRender: 50 * 1024 * 1024,
  /** Hard wall-clock limit for one sandboxed HTML extraction (worker is terminated beyond it). */
  htmlExtractionTimeoutMs: 20_000,
  /** PDF extraction bounds (page count fits wiki.source_snapshot.page_count smallint). */
  pdfMaxPages: 2_000,
  pdfTimeoutMs: 60_000,
  /** DOM nesting beyond this depth is flattened to text before extraction (stack-safety bound). */
  maxDomDepth: 256,
  /** Absolute BFS bounds from the `wiki.crawl_target` CHECK constraints. */
  maxDepth: 3,
  maxPages: 100,
} as const;
