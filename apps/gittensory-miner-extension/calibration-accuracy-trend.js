// Browser-safe copy of packages/gittensory-engine/src/calibration-accuracy-trend.ts (#4268).
// Keep algorithm changes in sync with the engine module — extension panels cannot import the engine package.

const DOCUMENTED_CALIBRATION_BASELINE = 0.62;
const CALIBRATION_ACCURACY_TREND_DEFAULT_WINDOW_DAYS = 30;

function parseObservedAtMs(observedAt) {
  const ms = Date.parse(observedAt);
  return Number.isFinite(ms) ? ms : null;
}

function resolveDelta(combinedAccuracy, deltaFromBaseline) {
  if (deltaFromBaseline !== undefined && deltaFromBaseline !== null) return deltaFromBaseline;
  if (combinedAccuracy === null) return null;
  return combinedAccuracy - DOCUMENTED_CALIBRATION_BASELINE;
}

function classifyTrendDirection(values) {
  if (values.length < 2) return "unknown";
  const first = values[0];
  const last = values[values.length - 1];
  const delta = last - first;
  if (Math.abs(delta) < 0.01) return "flat";
  return delta > 0 ? "improving" : "degrading";
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function buildCalibrationAccuracyTrendView(snapshots, options = {}) {
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
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(left.observedAt).localeCompare(String(right.observedAt)));

  const sparklineValues = points
    .map((point) => point.combinedAccuracy)
    .filter((value) => value !== null)
    .map((value) => Math.round(value * 1000) / 10);

  const trendDirection = classifyTrendDirection(
    points.map((point) => point.combinedAccuracy).filter((value) => value !== null),
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
    const only = points[0];
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

  const latest = points[points.length - 1];
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

const calibrationAccuracyTrendApi = {
  DOCUMENTED_CALIBRATION_BASELINE,
  CALIBRATION_ACCURACY_TREND_DEFAULT_WINDOW_DAYS,
  buildCalibrationAccuracyTrendView,
};

globalThis.__gittensoryMinerCalibrationAccuracyTrend = calibrationAccuracyTrendApi;

if (globalThis.__GITTENSORY_MINER_EXTENSION_TEST__) {
  globalThis.__gittensoryMinerCalibrationAccuracyTrendInternals = calibrationAccuracyTrendApi;
}
