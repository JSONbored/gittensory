import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** AMS observability surface (#4839): a minimal, OPT-IN, off-by-default metrics/tracing hook a self-hoster can
 * wire into their OWN observability stack (Prometheus/Grafana, or their own tracer), following the main product's
 * opt-in pattern (`src/selfhost/otel.ts` / `sentry.ts`: env-gated, every helper a no-op when unconfigured) rather
 * than requiring one. AMS's zero-infra "laptop mode" must keep working with NO observability stack present at all,
 * so nothing here runs unless a self-hoster explicitly opts in:
 *   - Metrics: a UNIFIED Prometheus text-exposition document (the per-ledger #4838/#4841 counters composed into one
 *     scrape target, plus build-info/scrape-time gauges) that `gittensory-miner metrics export` writes to
 *     `GITTENSORY_MINER_METRICS_FILE` (a node_exporter textfile-collector path) — or prints to stdout when no file
 *     is configured, so the command is always safe to run.
 *   - Tracing: `withMinerSpan`, a no-op-by-default span wrapper (mirrors `withOtelSpan`) an embedder can point at
 *     their own tracer via `onSpan`; when disabled it just runs the function with zero overhead.
 * This module is pure + dependency-free (only `node:fs`/`node:path`, all injectable) so it is fully unit-testable. */

/** Off by default — a laptop miner exports/traces nothing unless a self-hoster explicitly opts in (mirrors
 * `orb-export.js`'s `ORB_EXPORT_ENABLED_BY_DEFAULT`). */
export const OBSERVABILITY_ENABLED_BY_DEFAULT = false;

/** Build-info gauge: constant `1`, with the resolved miner version carried in the `version` label (the standard
 * Prometheus `*_build_info` idiom). */
export const MINER_BUILD_INFO = "gittensory_miner_build_info";

/** Gauge holding the Unix second at which a scrape document was generated, so staleness is visible in Grafana. */
export const MINER_SCRAPE_TIMESTAMP = "gittensory_miner_scrape_timestamp_seconds";

/** HELP-text escaping — backslash + newline (mirrors event-ledger-cli.js / miner-prediction-metrics.ts). */
function escapeHelpText(help) {
  return help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

/** Prometheus label-value escaping — backslash, double-quote, newline — so an arbitrary version string can never
 * break the metric line (mirrors event-ledger-cli.js's escapeLabelValue). */
function escapeLabelValue(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Resolve the opt-in metrics-export config from the environment. Off by default: with `GITTENSORY_MINER_METRICS_FILE`
 * unset (or blank) this returns `{ enabled: false, filePath: null }` and nothing downstream writes anything, so a
 * laptop miner with no observability stack is completely unaffected.
 */
export function resolveMetricsExportConfig(env = process.env) {
  const filePath =
    typeof env.GITTENSORY_MINER_METRICS_FILE === "string" ? env.GITTENSORY_MINER_METRICS_FILE.trim() : "";
  return { enabled: filePath !== "", filePath: filePath || null };
}

/**
 * Compose one Prometheus text-exposition document from already-rendered metric `sections` (e.g. the prediction and
 * event-ledger counters), prefixed with a `build_info` gauge and a scrape-timestamp gauge. Pure + deterministic:
 * non-string/blank sections are dropped, each section is trimmed, and the result has exactly one trailing newline.
 */
export function composeMinerScrapeDocument({ sections = [], version = "", nowMs = Date.now() } = {}) {
  const millis = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  const scrapeSeconds = Math.floor(millis / 1000);
  const head = [
    `# HELP ${MINER_BUILD_INFO} ${escapeHelpText("Running miner build info; constant 1 with the release in the version label.")}`,
    `# TYPE ${MINER_BUILD_INFO} gauge`,
    `${MINER_BUILD_INFO}{version="${escapeLabelValue(String(version))}"} 1`,
    `# HELP ${MINER_SCRAPE_TIMESTAMP} ${escapeHelpText("Unix timestamp (seconds) when this metrics document was generated.")}`,
    `# TYPE ${MINER_SCRAPE_TIMESTAMP} gauge`,
    `${MINER_SCRAPE_TIMESTAMP} ${scrapeSeconds}`,
  ];
  const blocks = [head.join("\n")];
  for (const section of sections) {
    if (typeof section !== "string") continue;
    const trimmed = section.trim();
    if (trimmed) blocks.push(trimmed);
  }
  return `${blocks.join("\n")}\n`;
}

/**
 * Atomically write a metrics-exposition `document` to `filePath` (write to a sibling temp file, then rename into
 * place) so a Prometheus node_exporter textfile collector never scrapes a half-written file. Filesystem calls are
 * injectable for tests; throws on a missing/blank path. Returns the resolved path written.
 */
export function writeMinerMetricsTextfile(document, filePath, deps = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("A metrics file path is required to write the miner metrics textfile.");
  }
  const target = filePath.trim();
  const mkdirSyncImpl = deps.mkdirSync ?? mkdirSync;
  const writeFileSyncImpl = deps.writeFileSync ?? writeFileSync;
  const renameSyncImpl = deps.renameSync ?? renameSync;
  mkdirSyncImpl(dirname(target), { recursive: true });
  const tempPath = `${target}.tmp`;
  writeFileSyncImpl(tempPath, document);
  renameSyncImpl(tempPath, target);
  return target;
}

/**
 * Run `fn` inside an optional span. When `options.enabled` is not true (the default) this is a pure pass-through —
 * `fn` runs with zero overhead and no observability dependency, keeping laptop mode inert. When enabled, it times
 * `fn` via `options.now` (default `Date.now`) and reports the outcome to `options.onSpan` (if given) as
 * `{ name, attributes, durationMs, ok, error? }`, then returns `fn`'s result (or rethrows its error). This is the
 * tracing integration point a self-hoster/embedder wires their own tracer into (mirrors `withOtelSpan`).
 */
export async function withMinerSpan(name, attributes, fn, options = {}) {
  if (options.enabled !== true) return fn();
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const onSpan = typeof options.onSpan === "function" ? options.onSpan : null;
  const startedAt = now();
  try {
    const result = await fn();
    onSpan?.({ name, attributes: attributes ?? {}, durationMs: now() - startedAt, ok: true });
    return result;
  } catch (error) {
    onSpan?.({ name, attributes: attributes ?? {}, durationMs: now() - startedAt, ok: false, error });
    throw error;
  }
}
