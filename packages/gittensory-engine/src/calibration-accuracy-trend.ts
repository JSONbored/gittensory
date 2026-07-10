import { DOCUMENTED_CALIBRATION_BASELINE } from "./phase7-calibration-loop.js";

// Calibration accuracy trend view (#4268). Extends the single-snapshot dashboard (#4261) with a read-only
// time-series projection over accumulated Phase7CalibrationLoopResult snapshots. Pure: no persistence, no
// controls — only reshapes historical combinedAccuracy values against DOCUMENTED_CALIBRATION_BASELINE.

export type CalibrationAccuracySnapshot = {
  observedAt: string;
  combinedAccuracy: number | null;
  deltaFromBaseline?: number | null;
};

export const CALIBRATION_ACCURACY_TREND_DEFAULT_WINDOW_DAYS = 30;

export type CalibrationAccuracyTrendStatus = "ready" | "insufficient_history";

export type CalibrationAccuracyTrendDirection = "improving" | "degrading" | "flat" | "unknown";

export type CalibrationAccuracyTrendPoint = {
  observedAt: string;
  combinedAccuracy: number | null;
  deltaFromBaseline: number | null;
  aboveBaseline: boolean | null;
};

export type CalibrationAccuracyTrendView = {
  status: CalibrationAccuracyTrendStatus;
  baseline: number;
  windowDays: number;
  pointCount: number;
  points: readonly CalibrationAccuracyTrendPoint[];
  sparklineValues: readonly number[];
  trendDirection: CalibrationAccuracyTrendDirection;
  headline: string;
  emptyMessage: string | null;
};

function parseObservedAtMs(observedAt: string): number | null {
  const ms = Date.parse(observedAt);
  return Number.isFinite(ms) ? ms : null;
}

function resolveDelta(combinedAccuracy: number | null, deltaFromBaseline: number | null | undefined): number | null {
  if (deltaFromBaseline !== undefined && deltaFromBaseline !== null) return deltaFromBaseline;
  if (combinedAccuracy === null) return null;
  return combinedAccuracy - DOCUMENTED_CALIBRATION_BASELINE;
}

function classifyTrendDirection(values: readonly number[]): CalibrationAccuracyTrendDirection {
  if (values.length < 2) return "unknown";
  const first = values[0]!;
  const last = values[values.length - 1]!;
  const delta = last - first;
  if (Math.abs(delta) < 0.01) return "flat";
  return delta > 0 ? "improving" : "degrading";
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Project accumulated calibration snapshots into a read-only trend view for CLI/extension panels.
 * `insufficient_history` covers empty and single-point installs; sparkline still renders one point when present.
 */
export function buildCalibrationAccuracyTrendView(
  snapshots: readonly CalibrationAccuracySnapshot[],
  options: { windowDays?: number; nowMs?: number } = {},
): CalibrationAccuracyTrendView {
  const windowDays = options.windowDays ?? CALIBRATION_ACCURACY_TREND_DEFAULT_WINDOW_DAYS;
  const nowMs = Number.isFinite(options.nowMs) ? Number(options.nowMs) : Date.now();
  const windowStartMs = nowMs - windowDays * 24 * 60 * 60 * 1000;

  const points = snapshots
    .map((snapshot) => {
      const observedAtMs = parseObservedAtMs(snapshot.observedAt);
      if (observedAtMs === null || observedAtMs < windowStartMs || observedAtMs > nowMs) return null;
      const deltaFromBaseline = resolveDelta(snapshot.combinedAccuracy, snapshot.deltaFromBaseline);
      return {
        observedAt: snapshot.observedAt,
        combinedAccuracy: snapshot.combinedAccuracy,
        deltaFromBaseline,
        aboveBaseline: snapshot.combinedAccuracy === null ? null : snapshot.combinedAccuracy >= DOCUMENTED_CALIBRATION_BASELINE,
      } satisfies CalibrationAccuracyTrendPoint;
    })
    .filter((point): point is CalibrationAccuracyTrendPoint => point !== null)
    .sort((left, right) => String(left.observedAt).localeCompare(String(right.observedAt)));

  const sparklineValues = points
    .map((point) => point.combinedAccuracy)
    .filter((value): value is number => value !== null)
    .map((value) => Math.round(value * 1000) / 10);

  const trendDirection = classifyTrendDirection(
    points.map((point) => point.combinedAccuracy).filter((value): value is number => value !== null),
  );

  if (points.length === 0) {
    return {
      status: "insufficient_history",
      baseline: DOCUMENTED_CALIBRATION_BASELINE,
      windowDays,
      pointCount: 0,
      points,
      sparklineValues,
      trendDirection: "unknown",
      headline: "No calibration history yet",
      emptyMessage: "Run the calibration loop to record snapshots before a trend can be shown.",
    };
  }

  if (points.length === 1) {
    const only = points[0]!;
    const accuracyLabel = only.combinedAccuracy === null ? "—" : formatPercent(only.combinedAccuracy);
    return {
      status: "insufficient_history",
      baseline: DOCUMENTED_CALIBRATION_BASELINE,
      windowDays,
      pointCount: 1,
      points,
      sparklineValues,
      trendDirection: "unknown",
      headline: `${accuracyLabel} accuracy (1 snapshot)`,
      emptyMessage: null,
    };
  }

  const latest = points[points.length - 1]!;
  const latestLabel = latest.combinedAccuracy === null ? "—" : formatPercent(latest.combinedAccuracy);
  const directionLabel =
    trendDirection === "improving" ? "improving" : trendDirection === "degrading" ? "degrading" : "stable";
  return {
    status: "ready",
    baseline: DOCUMENTED_CALIBRATION_BASELINE,
    windowDays,
    pointCount: points.length,
    points,
    sparklineValues,
    trendDirection,
    headline: `${latestLabel} latest · accuracy ${directionLabel} over ${windowDays}d`,
    emptyMessage: null,
  };
}
