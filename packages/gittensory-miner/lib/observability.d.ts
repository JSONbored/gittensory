/** AMS observability surface (#4839): opt-in, off-by-default metrics/tracing primitives. */

export const OBSERVABILITY_ENABLED_BY_DEFAULT: false;
export const MINER_BUILD_INFO: string;
export const MINER_SCRAPE_TIMESTAMP: string;

export type MetricsExportConfig = {
  enabled: boolean;
  filePath: string | null;
};

export type ComposeMinerScrapeDocumentInput = {
  sections?: ReadonlyArray<unknown>;
  version?: string;
  nowMs?: number;
};

export type MinerMetricsTextfileDeps = {
  mkdirSync?: (path: string, options: { recursive: boolean }) => unknown;
  writeFileSync?: (path: string, data: string) => void;
  renameSync?: (from: string, to: string) => void;
};

export type MinerSpanReport = {
  name: string;
  attributes: Record<string, unknown>;
  durationMs: number;
  ok: boolean;
  error?: unknown;
};

export type WithMinerSpanOptions = {
  enabled?: boolean;
  now?: () => number;
  onSpan?: (report: MinerSpanReport) => void;
};

export function resolveMetricsExportConfig(env?: Record<string, string | undefined>): MetricsExportConfig;

export function composeMinerScrapeDocument(input?: ComposeMinerScrapeDocumentInput): string;

export function writeMinerMetricsTextfile(
  document: string,
  filePath: string,
  deps?: MinerMetricsTextfileDeps,
): string;

export function withMinerSpan<T>(
  name: string,
  attributes: Record<string, unknown> | undefined,
  fn: () => T | Promise<T>,
  options?: WithMinerSpanOptions,
): Promise<T>;
