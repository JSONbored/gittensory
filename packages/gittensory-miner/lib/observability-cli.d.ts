/** AMS `metrics export` CLI (#4839): unify the per-ledger prediction (#4838) + event (#4841) Prometheus counters
 * into one opt-in scrape document, written to a textfile-collector path or stdout. */

export type ParsedMetricsExportArgs =
  | { file: string | null; stdout: boolean }
  | { error: string };

export type RunMetricsExportOptions = {
  env?: Record<string, string | undefined>;
  now?: () => number;
  initPredictionLedger?: () => { readPredictions: () => ReadonlyArray<{ conclusion: string }>; close: () => void };
  initEventLedger?: () => { readEvents: () => ReadonlyArray<{ type: string }>; close: () => void };
  writeMetricsTextfile?: (document: string, filePath: string) => string;
};

export function parseMetricsExportArgs(args: string[]): ParsedMetricsExportArgs;

export function runMetricsExport(args: string[], options?: RunMetricsExportOptions): number;
