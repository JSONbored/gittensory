import type { MinerPredictionMetricRow } from "@jsonbored/gittensory-engine";
import type { PredictionLedger } from "./prediction-ledger.js";

export function collectPredictionMetricRows(ledger: PredictionLedger): MinerPredictionMetricRow[];

export function runMetrics(
  args: string[],
  options?: { initPredictionLedger?: () => PredictionLedger },
): number;
