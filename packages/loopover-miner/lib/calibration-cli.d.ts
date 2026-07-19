import type { LedgerEntry } from "./event-ledger.js";
import type { PredictionLedgerEntry } from "./prediction-ledger.js";
import type { PredictedVerdictRecord, ObservedOutcomeRecord } from "./calibration-types.js";
/** Map prediction-ledger rows to predicted-verdict records: the target id becomes a string key and the recorded
 *  prediction verdict is the `conclusion`. Exported so callers other than this CLI (the MCP calibration-report
 *  tool, #5821) can build the identical join without re-implementing the mapping. */
export declare function toPredictionRecords(rows: PredictionLedgerEntry[]): PredictedVerdictRecord[];
/** Reduce the append-only `pr_outcome` event stream to the LATEST observed outcome per (repo, PR), as
 *  observed-outcome records. `recordedAt` comes from the event's own timestamp (always present), so an outcome is
 *  never dropped for lacking a `closedAt`. Malformed payloads are skipped. Exported for the same reason as
 *  {@link toPredictionRecords} above. */
export declare function toOutcomeRecords(events: LedgerEntry[]): ObservedOutcomeRecord[];
/**
 * Run `loopover-miner calibration [--json]`. Reads the prediction ledger + PR-outcome events, joins them into a
 * calibration report, and prints it (a JSON dump under `--json`, else a per-project text summary). Returns the
 * process exit code: 0 on success, 1 on an unknown option.
 */
export declare function runCalibrationCli(args?: string[], env?: Record<string, string | undefined>): number;
