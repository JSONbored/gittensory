import { buildCalibrationAccuracyTrendView } from "@jsonbored/gittensory-engine";
import { initCalibrationSnapshotLedger, toCalibrationAccuracySnapshots } from "./calibration-snapshot-ledger.js";

// Read-only calibration accuracy trend collector (#4268). Reads accumulated snapshot history from the local
// ledger and projects it through the engine trend builder for CLI output or extension handoff.

/**
 * Pure collector over an injected calibration snapshot ledger (mirrors collectPortfolioDashboard).
 */
export function collectCalibrationAccuracyTrend(sources, options = {}) {
  const ledger = sources?.calibrationSnapshotLedger;
  if (!ledger || typeof ledger.readSnapshots !== "function") throw new Error("invalid_calibration_snapshot_ledger");
  const snapshots = toCalibrationAccuracySnapshots(ledger.readSnapshots());
  return buildCalibrationAccuracyTrendView(snapshots, {
    windowDays: options.windowDays,
    nowMs: options.nowMs,
  });
}

export function parseCalibrationTrendArgs(args = []) {
  for (const token of args) {
    if (token === "--json") continue;
    if (token.startsWith("-")) return { error: `Unknown option: ${token}` };
    return { error: "Usage: gittensory-miner calibration trend [--json]" };
  }
  return { json: args.includes("--json") };
}

function renderCalibrationTrendText(view) {
  if (view.emptyMessage) return `${view.headline}\n${view.emptyMessage}`;
  const baseline = `${Math.round(view.baseline * 100)}%`;
  const spark = view.sparklineValues.length > 0 ? view.sparklineValues.join(", ") : "—";
  return [
    view.headline,
    `baseline: ${baseline} · window: ${view.windowDays}d · points: ${view.pointCount} · trend: ${view.trendDirection}`,
    `sparkline: ${spark}`,
  ].join("\n");
}

/** CLI glue for `gittensory-miner calibration trend [--json]`. */
export function runCalibrationTrend(args = [], options = {}) {
  const parsed = parseCalibrationTrendArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }
  const ownsLedger = options.initCalibrationSnapshotLedger === undefined;
  const calibrationSnapshotLedger = (options.initCalibrationSnapshotLedger ?? initCalibrationSnapshotLedger)();
  try {
    const view = collectCalibrationAccuracyTrend(
      { calibrationSnapshotLedger },
      { nowMs: Number.isFinite(options.nowMs) ? options.nowMs : Date.now() },
    );
    console.log(parsed.json ? JSON.stringify(view, null, 2) : renderCalibrationTrendText(view));
    return 0;
  } finally {
    if (ownsLedger) calibrationSnapshotLedger.close();
  }
}
