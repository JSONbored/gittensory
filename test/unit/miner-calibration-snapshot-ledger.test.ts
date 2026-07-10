import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  initCalibrationSnapshotLedger,
  resolveCalibrationSnapshotLedgerDbPath,
  toCalibrationAccuracySnapshots,
} from "../../packages/gittensory-miner/lib/calibration-snapshot-ledger.js";

const ledgers: Array<{ close: () => void }> = [];
const roots: string[] = [];

function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-calibration-snapshot-"));
  roots.push(root);
  const ledger = initCalibrationSnapshotLedger(join(root, "calibration-snapshot-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("miner calibration snapshot ledger (#4268)", () => {
  it("resolveCalibrationSnapshotLedgerDbPath honors explicit DB, config-dir, XDG, then home default", () => {
    expect(resolveCalibrationSnapshotLedgerDbPath({ GITTENSORY_MINER_CALIBRATION_SNAPSHOT_DB: "/custom/cal.sqlite3" })).toBe(
      "/custom/cal.sqlite3",
    );
    expect(resolveCalibrationSnapshotLedgerDbPath({ GITTENSORY_MINER_CONFIG_DIR: "/state" })).toBe(
      join("/state", "calibration-snapshot-ledger.sqlite3"),
    );
    expect(resolveCalibrationSnapshotLedgerDbPath({ XDG_CONFIG_HOME: "/xdg" })).toBe(
      join("/xdg", "gittensory-miner", "calibration-snapshot-ledger.sqlite3"),
    );
    expect(resolveCalibrationSnapshotLedgerDbPath({})).toMatch(/gittensory-miner[\\/]calibration-snapshot-ledger\.sqlite3$/);
  });

  it("appends snapshots and reads them back in observed-at order", () => {
    const ledger = tempLedger();
    const first = ledger.appendSnapshot({
      observedAt: "2026-07-01T00:00:00.000Z",
      combinedAccuracy: 0.6,
      deltaFromBaseline: -0.02,
      engineVersion: "0.2.0",
    });
    const second = ledger.appendSnapshot({
      observedAt: "2026-07-08T00:00:00.000Z",
      combinedAccuracy: 0.7,
      engineVersion: "0.2.0",
    });
    expect(ledger.readSnapshots()).toEqual([first, second]);
    expect(toCalibrationAccuracySnapshots(ledger.readSnapshots())).toEqual([
      { observedAt: "2026-07-01T00:00:00.000Z", combinedAccuracy: 0.6, deltaFromBaseline: -0.02 },
      { observedAt: "2026-07-08T00:00:00.000Z", combinedAccuracy: 0.7, deltaFromBaseline: null },
    ]);
  });

  it("defaults observedAt and engineVersion when omitted", () => {
    const ledger = tempLedger();
    const row = ledger.appendSnapshot({ combinedAccuracy: 0.65 });
    expect(typeof row.observedAt).toBe("string");
    expect(row.engineVersion).toBe("unknown");
  });

  it("rejects invalid snapshot inputs", () => {
    const ledger = tempLedger();
    expect(() => ledger.appendSnapshot(null as never)).toThrow(/invalid_calibration_snapshot_input/);
    expect(() => ledger.appendSnapshot({ observedAt: "bad-date", combinedAccuracy: 0.5 })).toThrow(/invalid_observed_at/);
    expect(() => ledger.appendSnapshot({ combinedAccuracy: Number.NaN })).toThrow(/invalid_combined_accuracy/);
    expect(() => ledger.appendSnapshot({ combinedAccuracy: 0.5, deltaFromBaseline: Number.NaN })).toThrow(
      /invalid_delta_from_baseline/,
    );
  });
});
