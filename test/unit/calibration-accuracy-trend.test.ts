import { describe, expect, it } from "vitest";
import { buildCalibrationAccuracyTrendView } from "../../packages/gittensory-engine/src/calibration-accuracy-trend.js";
import { DOCUMENTED_CALIBRATION_BASELINE } from "../../packages/gittensory-engine/src/phase7-calibration-loop.js";

const NOW = Date.parse("2026-07-10T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function snapshot(daysAgo: number, combinedAccuracy: number | null, deltaFromBaseline?: number | null) {
  const row: { observedAt: string; combinedAccuracy: number | null; deltaFromBaseline?: number | null } = {
    observedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    combinedAccuracy,
  };
  if (deltaFromBaseline !== undefined) row.deltaFromBaseline = deltaFromBaseline;
  return row;
}

describe("buildCalibrationAccuracyTrendView (#4268)", () => {
  it("returns an empty/sparse-history state when there are no snapshots in the window", () => {
    const view = buildCalibrationAccuracyTrendView([], { nowMs: NOW });
    expect(view.status).toBe("insufficient_history");
    expect(view.pointCount).toBe(0);
    expect(view.sparklineValues).toEqual([]);
    expect(view.trendDirection).toBe("unknown");
    expect(view.headline).toBe("No calibration history yet");
    expect(view.emptyMessage).toContain("Run the calibration loop");
    expect(view.baseline).toBe(DOCUMENTED_CALIBRATION_BASELINE);
  });

  it("filters invalid and out-of-window snapshots", () => {
    const view = buildCalibrationAccuracyTrendView(
      [
        { observedAt: "not-a-date", combinedAccuracy: 0.7 },
        snapshot(40, 0.5),
        snapshot(5, 0.7),
      ],
      { nowMs: NOW, windowDays: 30 },
    );
    expect(view.pointCount).toBe(1);
    expect(view.headline).toBe("70% accuracy (1 snapshot)");
  });

  it("renders a single-point install as insufficient history without an empty message", () => {
    const view = buildCalibrationAccuracyTrendView([snapshot(2, 0.71)], { nowMs: NOW });
    expect(view.status).toBe("insufficient_history");
    expect(view.pointCount).toBe(1);
    expect(view.sparklineValues).toEqual([71]);
    expect(view.headline).toBe("71% accuracy (1 snapshot)");
    expect(view.emptyMessage).toBeNull();
  });

  it("projects a multi-point improving series above the documented baseline", () => {
    const view = buildCalibrationAccuracyTrendView(
      [snapshot(10, 0.58), snapshot(5, 0.64), snapshot(1, 0.72)],
      { nowMs: NOW },
    );
    expect(view.status).toBe("ready");
    expect(view.trendDirection).toBe("improving");
    expect(view.pointCount).toBe(3);
    expect(view.sparklineValues).toEqual([58, 64, 72]);
    expect(view.headline).toContain("72% latest");
    expect(view.headline).toContain("improving");
    expect(view.points.every((point) => point.aboveBaseline === point.combinedAccuracy! >= DOCUMENTED_CALIBRATION_BASELINE)).toBe(true);
  });

  it("projects a multi-point degrading series and honors explicit deltaFromBaseline", () => {
    const view = buildCalibrationAccuracyTrendView(
      [
        snapshot(8, 0.75, 0.13),
        snapshot(4, 0.68, 0.06),
        snapshot(1, 0.55, -0.07),
      ],
      { nowMs: NOW },
    );
    expect(view.status).toBe("ready");
    expect(view.trendDirection).toBe("degrading");
    expect(view.points[0]?.deltaFromBaseline).toBe(0.13);
    expect(view.headline).toContain("degrading");
  });

  it("classifies a flat trend when movement is within one percentage point", () => {
    const view = buildCalibrationAccuracyTrendView([snapshot(6, 0.64), snapshot(1, 0.645)], { nowMs: NOW });
    expect(view.trendDirection).toBe("flat");
    expect(view.headline).toContain("stable");
  });

  it("renders a single snapshot with null combined accuracy as an em dash headline", () => {
    const view = buildCalibrationAccuracyTrendView([snapshot(2, null)], { nowMs: NOW });
    expect(view.headline).toBe("— accuracy (1 snapshot)");
  });

  it("skips null combined-accuracy values in the sparkline while keeping the point row", () => {
    const view = buildCalibrationAccuracyTrendView([snapshot(6, null), snapshot(1, 0.66)], { nowMs: NOW });
    expect(view.sparklineValues).toEqual([66]);
    expect(view.points[0]?.aboveBaseline).toBeNull();
  });

  it("falls back to Date.now when nowMs is not finite", () => {
    const view = buildCalibrationAccuracyTrendView([snapshot(0, 0.66)], { nowMs: Number.NaN });
    expect(view.pointCount).toBe(1);
  });

  it("formats a ready multi-point series whose latest accuracy is missing", () => {
    const view = buildCalibrationAccuracyTrendView([snapshot(6, 0.64), snapshot(1, null)], { nowMs: NOW });
    expect(view.status).toBe("ready");
    expect(view.headline).toContain("— latest");
  });
});
