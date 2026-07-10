import { afterEach, describe, expect, it, vi } from "vitest";
import type { CalibrationSnapshotLedger } from "../../packages/gittensory-miner/lib/calibration-snapshot-ledger.js";

vi.mock("@jsonbored/gittensory-engine", async () => {
  const trend = await import("../../packages/gittensory-engine/src/calibration-accuracy-trend");
  return { buildCalibrationAccuracyTrendView: trend.buildCalibrationAccuracyTrendView };
});

import { runCalibrationCli } from "../../packages/gittensory-miner/lib/calibration-cli.js";
import {
  collectCalibrationAccuracyTrend,
  parseCalibrationTrendArgs,
  runCalibrationTrend,
} from "../../packages/gittensory-miner/lib/calibration-trend.js";

const NOW = Date.parse("2026-07-10T00:00:00.000Z");

function mockLedger(
  snapshots: Array<{ observedAt: string; combinedAccuracy: number | null; deltaFromBaseline?: number | null }>,
): CalibrationSnapshotLedger {
  return {
    dbPath: "/tmp/test.sqlite3",
    readSnapshots: () =>
      snapshots.map((snapshot, index) => ({
        id: index + 1,
        observedAt: snapshot.observedAt,
        combinedAccuracy: snapshot.combinedAccuracy,
        deltaFromBaseline: snapshot.deltaFromBaseline ?? null,
        engineVersion: "0.2.0",
      })),
    appendSnapshot: () => {
      throw new Error("not_implemented");
    },
    close: () => {},
  };
}

afterEach(() => vi.restoreAllMocks());

describe("collectCalibrationAccuracyTrend (#4268)", () => {
  it("throws when the injected snapshot ledger is unusable", () => {
    expect(() => collectCalibrationAccuracyTrend({} as never)).toThrow("invalid_calibration_snapshot_ledger");
  });

  it("projects ledger rows through the engine trend builder", () => {
    const view = collectCalibrationAccuracyTrend(
      {
        calibrationSnapshotLedger: mockLedger([
          { observedAt: "2026-07-01T00:00:00.000Z", combinedAccuracy: 0.58, deltaFromBaseline: -0.04 },
          { observedAt: "2026-07-08T00:00:00.000Z", combinedAccuracy: 0.7, deltaFromBaseline: 0.08 },
        ]),
      },
      { nowMs: NOW },
    );
    expect(view.status).toBe("ready");
    expect(view.trendDirection).toBe("improving");
  });
});

describe("parseCalibrationTrendArgs (#4268)", () => {
  it("accepts --json and rejects unknown options or stray positionals", () => {
    expect(parseCalibrationTrendArgs([])).toEqual({ json: false });
    expect(parseCalibrationTrendArgs(["--json"])).toEqual({ json: true });
    expect(parseCalibrationTrendArgs(["--nope"])).toEqual({ error: expect.stringContaining("Unknown option") });
    expect(parseCalibrationTrendArgs(["extra"])).toEqual({ error: expect.stringContaining("Usage: gittensory-miner calibration trend") });
  });
});

describe("runCalibrationTrend (#4268)", () => {
  it("prints text and JSON from the injected ledger, and errors on bad args", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ledger = mockLedger([{ observedAt: "2026-07-08T00:00:00.000Z", combinedAccuracy: 0.7, deltaFromBaseline: 0.08 }]);

    expect(runCalibrationTrend([], { initCalibrationSnapshotLedger: () => ledger, nowMs: NOW })).toBe(0);
    expect(log.mock.calls[0]?.[0]).toContain("1 snapshot");

    expect(runCalibrationTrend(["--json"], { initCalibrationSnapshotLedger: () => ledger, nowMs: NOW })).toBe(0);
    expect(JSON.parse(String(log.mock.calls[1]?.[0])).status).toBe("insufficient_history");

    expect(runCalibrationTrend(["--bad"], { initCalibrationSnapshotLedger: () => ledger })).toBe(2);
    expect(error).toHaveBeenCalled();
  });
});

describe("runCalibrationCli (#4268)", () => {
  it("dispatches the trend subcommand and rejects unknown subcommands", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const ledger = mockLedger([]);

    expect(runCalibrationCli("trend", [], { initCalibrationSnapshotLedger: () => ledger, nowMs: NOW })).toBe(0);
    expect(log).toHaveBeenCalled();

    expect(runCalibrationCli("snapshot", [], { initCalibrationSnapshotLedger: () => ledger })).toBe(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Unknown calibration subcommand"));
  });
});
