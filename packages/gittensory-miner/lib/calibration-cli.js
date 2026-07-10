import { runCalibrationTrend } from "./calibration-trend.js";

const CALIBRATION_TREND_USAGE = "Usage: gittensory-miner calibration trend [--json]";

export function runCalibrationCli(subcommand, args, options = {}) {
  if (subcommand === "trend") return runCalibrationTrend(args, options);
  console.error(`Unknown calibration subcommand: ${subcommand ?? ""}. ${CALIBRATION_TREND_USAGE}`);
  return 2;
}
