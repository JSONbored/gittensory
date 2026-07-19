// `loopover-miner calibration [--json]` (#4849): a read-only report joining the miner's own predicted gate
// verdicts (prediction-ledger) with the realized PR outcomes it later observed (event-ledger `pr_outcome`
// events), via the pure buildCalibrationReport join. Opens both local stores, maps their rows to the
// calibration record shapes, renders, and closes. Never modifies the live scoring/calibration logic.
import { buildCalibrationReport } from "./calibration.js";
import { initEventLedger, resolveEventLedgerDbPath } from "./event-ledger.js";
import { MINER_PR_OUTCOME_EVENT } from "./pr-outcome.js";
import { initPredictionLedger, resolvePredictionLedgerDbPath } from "./prediction-ledger.js";
import { reportCliFailure, describeCliError } from "./cli-error.js";
const CALIBRATION_USAGE = "Usage: loopover-miner calibration [--json]";
/** Map prediction-ledger rows to predicted-verdict records: the target id becomes a string key and the recorded
 *  prediction verdict is the `conclusion`. Exported so callers other than this CLI (the MCP calibration-report
 *  tool, #5821) can build the identical join without re-implementing the mapping. */
export function toPredictionRecords(rows) {
    return rows.map((row) => ({
        project: row.repoFullName,
        targetId: String(row.targetId),
        predictedDecision: row.conclusion,
        recordedAt: row.ts,
    }));
}
/** Reduce the append-only `pr_outcome` event stream to the LATEST observed outcome per (repo, PR), as
 *  observed-outcome records. `recordedAt` comes from the event's own timestamp (always present), so an outcome is
 *  never dropped for lacking a `closedAt`. Malformed payloads are skipped. Exported for the same reason as
 *  {@link toPredictionRecords} above. */
export function toOutcomeRecords(events) {
    const latest = new Map();
    for (const event of events) {
        if (event?.type !== MINER_PR_OUTCOME_EVENT)
            continue;
        const payload = event.payload;
        if (!payload || !Number.isInteger(payload.prNumber) || typeof payload.decision !== "string")
            continue;
        latest.set(`${event.repoFullName}:${payload.prNumber}`, {
            // ObservedOutcomeRecord.project is declared non-nullable, but LedgerEntry.repoFullName is `string | null`
            // for other event kinds; a pr_outcome event always carries a real repoFullName in practice, so this passes
            // the value through unchanged rather than substituting a fallback that would be a behavior change.
            project: event.repoFullName,
            targetId: String(payload.prNumber),
            outcomeDecision: payload.decision,
            recordedAt: event.createdAt,
        });
    }
    return [...latest.values()];
}
function renderReportText(report) {
    if (!report.hasSignal) {
        console.log("calibration: no decided predictions yet (predictions need a realized merge/close outcome).");
        return;
    }
    for (const row of report.rows) {
        const merge = row.mergePrecision === null ? "n/a" : `${Math.round(row.mergePrecision * 100)}%`;
        const close = row.closePrecision === null ? "n/a" : `${Math.round(row.closePrecision * 100)}%`;
        console.log(`${row.project}: ${row.decided} decided | ` +
            `merge ${row.mergeConfirmed}/${row.wouldMerge} (${merge}) | ` +
            `close ${row.closeConfirmed}/${row.wouldClose} (${close}) | hold ${row.hold}`);
    }
}
/**
 * Run `loopover-miner calibration [--json]`. Reads the prediction ledger + PR-outcome events, joins them into a
 * calibration report, and prints it (a JSON dump under `--json`, else a per-project text summary). Returns the
 * process exit code: 0 on success, 1 on an unknown option.
 */
export function runCalibrationCli(args = [], env = process.env) {
    const json = args.includes("--json");
    // This command takes no positional arguments, so anything that is not `--json` is a mistake -- including a
    // bare positional (`calibration foo`), which a `startsWith("-")` check silently let through (#5834). Mirrors
    // the strict zero-positional discipline `ledger list` (event-ledger-cli.js) already applies.
    const unknown = args.find((token) => token !== "--json");
    if (unknown) {
        return reportCliFailure(json, `Unknown option: ${unknown}. ${CALIBRATION_USAGE}`, 1);
    }
    let predictionStore;
    let eventLedger;
    try {
        predictionStore = initPredictionLedger(resolvePredictionLedgerDbPath(env));
        eventLedger = initEventLedger(resolveEventLedgerDbPath(env));
        const report = buildCalibrationReport(toPredictionRecords(predictionStore.readPredictions()), toOutcomeRecords(eventLedger.readEvents()));
        if (json)
            console.log(JSON.stringify(report, null, 2));
        else
            renderReportText(report);
        return 0;
    }
    catch (error) {
        return reportCliFailure(json, describeCliError(error));
    }
    finally {
        predictionStore?.close();
        eventLedger?.close();
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2FsaWJyYXRpb24tY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiY2FsaWJyYXRpb24tY2xpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLDJHQUEyRztBQUMzRywwR0FBMEc7QUFDMUcscUdBQXFHO0FBQ3JHLHFHQUFxRztBQUNyRyxPQUFPLEVBQUUsc0JBQXNCLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUMxRCxPQUFPLEVBQUUsZUFBZSxFQUFFLHdCQUF3QixFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFFOUUsT0FBTyxFQUFFLHNCQUFzQixFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFDekQsT0FBTyxFQUFFLG9CQUFvQixFQUFFLDZCQUE2QixFQUFFLE1BQU0sd0JBQXdCLENBQUM7QUFHN0YsT0FBTyxFQUFFLGdCQUFnQixFQUFFLGdCQUFnQixFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFFcEUsTUFBTSxpQkFBaUIsR0FBRyw0Q0FBNEMsQ0FBQztBQUV2RTs7cUZBRXFGO0FBQ3JGLE1BQU0sVUFBVSxtQkFBbUIsQ0FBQyxJQUE2QjtJQUMvRCxPQUFPLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxHQUFHLEVBQUUsRUFBRSxDQUFDLENBQUM7UUFDeEIsT0FBTyxFQUFFLEdBQUcsQ0FBQyxZQUFZO1FBQ3pCLFFBQVEsRUFBRSxNQUFNLENBQUMsR0FBRyxDQUFDLFFBQVEsQ0FBQztRQUM5QixpQkFBaUIsRUFBRSxHQUFHLENBQUMsVUFBVTtRQUNqQyxVQUFVLEVBQUUsR0FBRyxDQUFDLEVBQUU7S0FDbkIsQ0FBQyxDQUFDLENBQUM7QUFDTixDQUFDO0FBRUQ7Ozt5Q0FHeUM7QUFDekMsTUFBTSxVQUFVLGdCQUFnQixDQUFDLE1BQXFCO0lBQ3BELE1BQU0sTUFBTSxHQUFHLElBQUksR0FBRyxFQUFpQyxDQUFDO0lBQ3hELEtBQUssTUFBTSxLQUFLLElBQUksTUFBTSxFQUFFLENBQUM7UUFDM0IsSUFBSSxLQUFLLEVBQUUsSUFBSSxLQUFL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