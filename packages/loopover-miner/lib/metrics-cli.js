import { renderMinerPredictionMetrics } from "@loopover/engine";
import { initPredictionLedger } from "./prediction-ledger.js";
import { argsWantJson, describeCliError, reportCliFailure } from "./cli-error.js";
// `metrics` (#4838): render the miner's prediction-calibration counters as Prometheus text-exposition to stdout,
// for a scrape wrapper or cron redirect. The counters are produced by the engine's already-built
// renderMinerPredictionMetrics (packages/loopover-engine/src/miner-prediction-metrics.ts) -- this command only
// reads the local prediction ledger and feeds it in, never touching the renderer itself. Strictly local + offline:
// no network, no writes.
const METRICS_USAGE = "Usage: loopover-miner metrics";
/**
 * Project prediction-ledger rows onto the engine renderer's metric-row shape -- the predicted `conclusion` only.
 * The realized-outcome pairing (`correct`) is intentionally left unset: the miner has no outcome-join yet, so the
 * correct/incorrect counters stay zero and only `predictions_total{conclusion}` moves -- exactly how the renderer
 * is designed to degrade before outcome-pairing exists (see its header comment).
 */
export function collectPredictionMetricRows(ledger) {
    return ledger.readPredictions().map((entry) => ({ conclusion: entry.conclusion }));
}
// Open the local prediction ledger (or a test-injected one) for the duration of `run`, closing it only when we
// opened it -- an injected ledger is owned by the caller. Mirrors event-ledger-cli.js's withEventLedger.
function withPredictionLedger(options, run) {
    const ownsLedger = options.initPredictionLedger === undefined;
    const ledger = (options.initPredictionLedger ?? initPredictionLedger)();
    try {
        return run(ledger);
    }
    finally {
        if (ownsLedger)
            ledger.close();
    }
}
export function runMetrics(args, options = {}) {
    if (args.length > 0) {
        return reportCliFailure(argsWantJson(args), METRICS_USAGE);
    }
    try {
        return withPredictionLedger(options, (ledger) => {
            // renderMinerPredictionMetrics returns a newline-terminated document; console.log re-adds the terminator, so
            // trim it to emit exactly one trailing newline.
            console.log(renderMinerPredictionMetrics(collectPredictionMetricRows(ledger)).trimEnd());
            return 0;
        });
    }
    catch (error) {
        return reportCliFailure(argsWantJson(args), describeCliError(error));
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWV0cmljcy1jbGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJtZXRyaWNzLWNsaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUsNEJBQTRCLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUVoRSxPQUFPLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSx3QkFBd0IsQ0FBQztBQUU5RCxPQUFPLEVBQUUsWUFBWSxFQUFFLGdCQUFnQixFQUFFLGdCQUFnQixFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFFbEYsaUhBQWlIO0FBQ2pILGlHQUFpRztBQUNqRywrR0FBK0c7QUFDL0csbUhBQW1IO0FBQ25ILHlCQUF5QjtBQUV6QixNQUFNLGFBQWEsR0FBRywrQkFBK0IsQ0FBQztBQUV0RDs7Ozs7R0FLRztBQUNILE1BQU0sVUFBVSwyQkFBMkIsQ0FBQyxNQUF3QjtJQUNsRSxPQUFPLE1BQU0sQ0FBQyxlQUFlLEVBQUUsQ0FBQyxHQUFHLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLENBQUMsRUFBRSxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVUsRUFBRSxDQUFDLENBQUMsQ0FBQztBQUNyRixDQUFDO0FBRUQsK0dBQStHO0FBQy9HLHlHQUF5RztBQUN6RyxTQUFTLG9CQUFvQixDQUMzQixPQUEwRCxFQUMxRCxHQUFvQztJQUVwQyxNQUFNLFVBQVUsR0FBRyxPQUFPLENBQUMsb0JBQW9CLEtBQUssU0FBUyxDQUFDO0lBQzlELE1BQU0sTUFBTSxHQUFHLENBQUMsT0FBTyxDQUFDLG9CQUFvQixJQUFJLG9CQUFvQixDQUFDLEVBQUUsQ0FBQztJQUN4RSxJQUFJLENBQUM7UUFDSCxPQUFPLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUNyQixDQUFDO1lBQVMsQ0FBQztRQUNULElBQUksVUFBVTtZQUFFLE1BQU0sQ0FBQyxLQUFLLEVBQUUsQ0FBQztJQUNqQyxDQUFDO0FBQ0gsQ0FBQztBQUVELE1BQU0sVUFBVSxVQUFVLENBQUMsSUFBYyxFQUFFLFVBQTZELEVBQUU7SUFDeEcsSUFBSSxJQUFJLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDO1FBQ3BCLE9BQU8sZ0JBQWdCLENBQUMsWUFBWSxDQUFDLElBQUksQ0FBQyxFQUFFLGFBQWEsQ0FBQyxDQUFDO0lBQzdELENBQUM7SUFFRCxJQUFJLENBQUM7UUFDSCxPQUFPLG9CQUFvQixDQUFDLE9BQU8sRUFBRSxDQUFDLE1BQU0sRUFBRSxFQUFFO1lBQzlDLDZHQUE2RztZQUM3RyxnREFBZ0Q7WUFDaEQsT0FBTyxDQUFDLEdBQUcsQ0FBQyw0QkFBNEIsQ0FBQywyQkFBMkIsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLE9BQU8sRUFBRSxDQUFDLENBQUM7WUFDekYsT0FBTyxDQUFDLENBQUM7UUFDWCxDQUFDLENBQUMsQ0FBQztJQUNMLENBQUM7SUFBQyxPQUFPLEtBQUssRUFBRSxDQUFDO1FBQ2YsT0FBTyxnQkFBZ0IsQ0FBQyxZQUFZLENBQUMsSUFBSSxDQUFDLEVBQUUsZ0JBQWdCLENBQUMsS0FBSyxDQUFDLENBQUMsQ0FBQztJQUN2RSxDQUFDO0FBQ0gsQ0FBQyJ9