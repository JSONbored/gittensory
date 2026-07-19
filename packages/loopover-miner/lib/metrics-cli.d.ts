import type { MinerPredictionMetricRow } from "@loopover/engine";
import type { PredictionLedger } from "./prediction-ledger.js";
/**
 * Project prediction-ledger rows onto the engine renderer's metric-row shape -- the predicted `conclusion` only.
 * The realized-outcome pairing (`correct`) is intentionally left unset: the miner has no outcome-join yet, so the
 * correct/incorrect counters stay zero and only `predictions_total{conclusion}` moves -- exactly how the renderer
 * is designed to degrade before outcome-pairing exists (see its header comment).
 */
export declare function collectPredictionMetricRows(ledger: PredictionLedger): MinerPredictionMetricRow[];
export declare function runMetrics(args: string[], options?: {
    initPredictionLedger?: () => PredictionLedger;
}): number;
