// Read-only Phase 7 calibration dashboard render (#4261). Pure: turns a computed Phase7CalibrationLoopResult
// (from computePhase7CalibrationLoop, phase7-calibration-loop.ts) into a compact, deterministic, human-readable
// view — CLI-suitable text today; a apps/gittensory-miner-ui/ panel can render the same result later.
//
// This is the read-only CONSUMER of the calibration module, never a producer: it renders, gates nothing, and
// mutates nothing. It explicitly handles the "no real data yet" state (combinedAccuracy === null) with a clear
// message rather than presenting an absent signal as a real 0% accuracy — that is the common case until the
// historical-replay scorers are wired to feed live numbers (#4248, maintainer-only), so this view is groundwork
// the wiring does not need to wait on.

import type { Phase7CalibrationLoopResult } from "./phase7-calibration-loop.js";

function pct(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

/**
 * Render a {@link Phase7CalibrationLoopResult} as a compact read-only dashboard. Surfaces the combined accuracy vs
 * the documented baseline (with the delta in percentage points), the per-source (`historical_replay` / `pr_outcome`)
 * accuracy + sample size + freshness, the replay-harness status and whether a replay run is due, and any hold
 * reasons. Deterministic — the same result always renders the same text.
 */
export function renderCalibrationDashboard(result: Phase7CalibrationLoopResult): string {
  const lines: string[] = ["Phase 7 self-review calibration"];

  if (result.combinedAccuracy === null) {
    lines.push("  combined accuracy: no data yet — the replay scorers are not wired to feed live numbers (#4248).");
  } else {
    // deltaFromBaseline is computed alongside combinedAccuracy, so it is non-null whenever the combined value is.
    const delta = result.deltaFromBaseline as number;
    const deltaPp = `${delta >= 0 ? "+" : ""}${Math.round(delta * 100)}pp`;
    lines.push(`  combined accuracy: ${pct(result.combinedAccuracy)} vs ${pct(result.baselineAccuracy)} baseline (${deltaPp})`);
  }

  for (const source of ["historical_replay", "pr_outcome"] as const) {
    const metric = result.bySource[source];
    lines.push(`  ${source}: ${pct(metric.accuracy)} (n=${metric.sampleSize}, ${metric.fresh ? "fresh" : "stale"})`);
  }

  lines.push(`  replay harness: ${result.replayHarnessStatus}${result.replayRunDue ? " — replay run due" : ""}`);
  if (result.holdReasons.length > 0) lines.push(`  holds: ${result.holdReasons.join("; ")}`);

  return lines.join("\n");
}
