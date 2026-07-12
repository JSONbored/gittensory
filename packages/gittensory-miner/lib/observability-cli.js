import { renderMinerPredictionMetrics } from "@jsonbored/gittensory-engine";
import { renderEventLedgerMetrics } from "./event-ledger-cli.js";
import { initEventLedger } from "./event-ledger.js";
import { collectPredictionMetricRows } from "./metrics-cli.js";
import { composeMinerScrapeDocument, resolveMetricsExportConfig, writeMinerMetricsTextfile } from "./observability.js";
import { initPredictionLedger } from "./prediction-ledger.js";
import { resolveMinerVersion } from "./version.js";

// `metrics export` (#4839): AMS's own opt-in metrics surface. Composes the per-ledger prediction (#4838) and
// event-ledger (#4841) Prometheus counters into ONE exposition document (plus build-info + scrape-time gauges) and
// either writes it atomically to the configured textfile-collector path (`--file` or GITTENSORY_MINER_METRICS_FILE)
// or prints it to stdout. Strictly local + offline: reads only local ledgers, writes only the one local file — so a
// laptop miner with no observability stack is unaffected (nothing runs unless this command is invoked).

const METRICS_EXPORT_USAGE = "Usage: gittensory-miner metrics export [--file <path>] [--stdout]";

/** Parse `metrics export` flags: `--file <path>` (write target) and `--stdout` (force stdout even if a file is
 * configured). Returns `{ error }` on any unknown token or a `--file` missing its value. */
export function parseMetricsExportArgs(args) {
  const result = { file: null, stdout: false };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--stdout") {
      result.stdout = true;
      continue;
    }
    if (token === "--file") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) return { error: METRICS_EXPORT_USAGE };
      result.file = value.trim();
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    return { error: METRICS_EXPORT_USAGE };
  }
  return result;
}

/**
 * Render + emit the unified miner metrics exposition. Writes to `--file` (highest precedence), else the
 * `GITTENSORY_MINER_METRICS_FILE` textfile-collector path; prints to stdout when `--stdout` is given or no file is
 * configured (so the command always does something safe). Dependencies (ledgers, env, clock, writer) are injectable.
 */
export function runMetricsExport(args, options = {}) {
  const parsed = parseMetricsExportArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  const env = options.env ?? process.env;
  const nowMs = typeof options.now === "function" ? options.now() : Date.now();
  const writeTextfile = options.writeMetricsTextfile ?? writeMinerMetricsTextfile;
  const ownsPrediction = options.initPredictionLedger === undefined;
  const ownsEvent = options.initEventLedger === undefined;
  const openPrediction = options.initPredictionLedger ?? initPredictionLedger;
  const openEvent = options.initEventLedger ?? initEventLedger;

  const config = resolveMetricsExportConfig(env);
  const targetFile = parsed.file ?? config.filePath;
  const toStdout = parsed.stdout || targetFile === null;

  // Close only ledgers we opened ourselves (an injected ledger is owned by the caller). Pushing a closer only after
  // a successful open means a mid-open throw never tries to close an unopened handle.
  const closers = [];
  try {
    const predictionLedger = openPrediction();
    if (ownsPrediction) closers.push(() => predictionLedger.close());
    const eventLedger = openEvent();
    if (ownsEvent) closers.push(() => eventLedger.close());
    const document = composeMinerScrapeDocument({
      sections: [
        renderMinerPredictionMetrics(collectPredictionMetricRows(predictionLedger)),
        renderEventLedgerMetrics(eventLedger.readEvents()),
      ],
      version: resolveMinerVersion(env),
      nowMs,
    });
    if (toStdout) {
      console.log(document.trimEnd());
    } else {
      const written = writeTextfile(document, targetFile);
      console.error(`gittensory-miner: wrote metrics exposition to ${written}`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    for (const close of closers) close();
  }
}
