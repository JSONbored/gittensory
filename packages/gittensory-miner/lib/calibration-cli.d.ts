import type { CalibrationSnapshotLedger } from "./calibration-snapshot-ledger.js";

export function runCalibrationCli(
  subcommand: string | undefined,
  args?: string[],
  options?: {
    initCalibrationSnapshotLedger?: () => CalibrationSnapshotLedger;
    nowMs?: number;
  },
): number;
