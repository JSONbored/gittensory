import type { CalibrationSnapshotLedger } from "./calibration-snapshot-ledger.js";

export type CalibrationAccuracyTrendView = {
  status: "ready" | "insufficient_history";
  baseline: number;
  windowDays: number;
  pointCount: number;
  points: readonly unknown[];
  sparklineValues: readonly number[];
  trendDirection: "improving" | "degrading" | "flat" | "unknown";
  headline: string;
  emptyMessage: string | null;
};

export type CalibrationTrendSources = {
  calibrationSnapshotLedger: Pick<CalibrationSnapshotLedger, "readSnapshots">;
};

export function collectCalibrationAccuracyTrend(
  sources: CalibrationTrendSources,
  options?: { windowDays?: number; nowMs?: number },
): CalibrationAccuracyTrendView;

export function parseCalibrationTrendArgs(args?: string[]): { json: boolean } | { error: string };

export function runCalibrationTrend(
  args?: string[],
  options?: {
    initCalibrationSnapshotLedger?: () => CalibrationSnapshotLedger;
    nowMs?: number;
  },
): number;
