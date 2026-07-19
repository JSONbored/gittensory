#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CLAIM_STATUSES, openClaimLedger } from "../lib/claim-ledger.js";
import { collectEventLedgerAuditFeed, normalizeAuditFeedMcpFilter, } from "../lib/event-ledger-cli.js";
import { initEventLedger } from "../lib/event-ledger.js";
import { collectManageStatus, collectRunPortfolio } from "../lib/manage-status.js";
import { collectPortfolioDashboard } from "../lib/portfolio-dashboard.js";
import { initPortfolioQueueStore } from "../lib/portfolio-queue.js";
import { initRunStateStore } from "../lib/run-state.js";
import { PLAN_STATUSES, openPlanStore } from "../lib/plan-store.js";
import { initGovernorLedger } from "../lib/governor-ledger.js";
import { collectStatus, runDoctorChecks } from "../lib/status.js";
import { buildCalibrationReport } from "../lib/calibration.js";
import { toOutcomeRecords, toPredictionRecords } from "../lib/calibration-cli.js";
import { initPredictionLedger } from "../lib/prediction-ledger.js";
import { loadMinerFileSecrets } from "../lib/env-file-indirection.js";
import { installCliSignalHandlers } from "../lib/process-lifecycle.js";
import { captureMinerErrorAndFlush, initMinerSentry } from "../lib/sentry.js";
// MCP stdio server for @loopover/miner (scaffold #5153). Mirrors the packages/loopover-mcp
// harness (MCP SDK server + stdio transport). Tools:
//   - loopover_miner_ping (#5153): trivial static health check, reads no AMS state.
//   - loopover_miner_get_portfolio_dashboard (#5155): read-only per-repo backlog dashboard, wrapping the
//     existing collectPortfolioDashboard aggregator (no new logic; same data as `queue dashboard --json`).
//   - loopover_miner_get_manage_status (#5822): read-only manage-phase status joining the portfolio queue, the
//     event ledger, and run-state via manage-status.js's collectManageStatus/collectRunPortfolio (no new join
//     logic; same { rows, runPortfolio } shape as `manage status --json`). Never calls GitHub, never mutates.
//   - loopover_miner_list_claims (#5156): read-only listing of the local claim ledger (optional repo/status
//     filter passed through to listClaims); exposes no claim/release mutation.
//   - loopover_miner_get_audit_feed (#5158): read-only metadata-only event-ledger audit feed via
//     collectEventLedgerAuditFeed() (same filters as `ledger list`; never returns payload_json).
//   - loopover_miner_get_run_state (#5160): read-only per-repo run-state via run-state.js's getRunState/
//     listRunStates (read-only analog of ORB's loopover_get_automation_state; no state-set mutation).
//   - loopover_miner_list_plans / loopover_miner_get_plan (#5161): read-only access to the persisted
//     plan store via plan-store.js's listPlans/loadPlan (distinct from ORB's stateless loopover_plan_status).
//   - loopover_miner_get_governor_decisions (#5159): read-only governor decision-log projection via
//     governor-ledger.js's readGovernorDecisions -- an explicit named-column read that excludes payload_json.
//   - loopover_miner_status (#5154): read-only status + doctor diagnostics via status.js's collectStatus/
//     runDoctorChecks (names/booleans/paths only -- never any env-var value, token, key, or credential).
//   - loopover_miner_get_calibration_report (#5821): read-only miner-local prediction-accuracy report, joining
//     the prediction ledger with observed pr_outcome events via calibration-cli.js's existing toPredictionRecords/
//     toOutcomeRecords mappers and calibration.js's buildCalibrationReport composer (no new join logic). Distinct
//     from ORB's hosted, maintainer-authenticated loopover_get_outcome_calibration tool.
// Read the version from this package's own package.json (always shipped) rather than a hand-synced
// literal, so a release bump never has a second place to forget -- same approach as the mcp harness.
// Resolve via fileURLToPath(import.meta.url) (a string) rather than `new URL(...)` so the path never
// materializes as a `URL` object -- the repo-root tsconfig this file is also checked under (its type
// surface is imported by the MCP unit tests) resolves the global `URL` to a shape whose iterator lacks
// `[Symbol.dispose]`, which readFileSync's node typings reject; a plain string sidesteps that entirely.
const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), "../package.json");
const ownPackageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
/** Optional filters accepted by loopover_miner_get_audit_feed (#5158). */
const auditFeedInputSchema = {
    repoFullName: z.string().min(1).optional(),
    since: z.number().int().nonnegative().optional(),
    type: z.string().min(1).optional(),
};
/** The static, non-secret payload the ping tool always returns, independent of any input or AMS state. */
export const MINER_PING_STATUS = { status: "ok", tool: "loopover_miner_ping" };
/**
 * Build the miner MCP server with its tools registered. `options.initPortfolioQueue`, `options.openClaimLedger`,
 * `options.initEventLedger`, `options.initRunStateStore`, `options.openPlanStore`, `options.initGovernorLedger`,
 * `options.collectStatus`, `options.runDoctorChecks`, and `options.nowMs` are injection seams for tests (default
 * to the real stores/readers and the wall clock); the ping tool needs none. Each store-backed tool opens its
 * store only when invoked and closes any store it opened.
 */
export function createMinerMcpServer(options = {}) {
    const server = new McpServer({ name: "loopover-miner", version: ownPackageJson.version });
    server.registerTool("loopover_miner_ping", {
        description: "Health check for the loopover-miner MCP server. Returns a static status object confirming the " +
            "server is reachable. Reads no AMS state and takes no arguments.",
        inputSchema: {},
    }, async () => ({ content: [{ type: "text", text: JSON.stringify(MINER_PING_STATUS) }] }));
    server.registerTool("loopover_miner_get_portfolio_dashboard", {
        description: "Read-only per-repo portfolio-queue backlog dashboard: status counts (queued/in_progress/done), totals, " +
            "and the oldest-queued age in ms. Wraps the existing collectPortfolioDashboard aggregator (no new logic) " +
            "-- the same data `loopover-miner queue dashboard --json` prints locally. Takes no arguments; mutates nothing.",
        inputSchema: {},
    }, async () => {
        const ownsQueue = options.initPortfolioQueue === undefined;
        const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
        try {
            const summary = collectPortfolioDashboard({ portfolioQueue }, { nowMs: options.nowMs ?? Date.now() });
            return { content: [{ type: "text", text: JSON.stringify(summary) }] };
        }
        finally {
            if (ownsQueue)
                portfolioQueue.close();
        }
    });
    server.registerTool("loopover_miner_get_manage_status", {
        description: "Read-only manage-phase status: the per-managed-PR rows `loopover-miner manage status` reports (branch, CI " +
            "state, gate verdict, outcome, last-polled-at, queue status/priority) plus the run-level portfolio view " +
            "(one row per tracked repo: run state, updated-at, PR count). Joins the portfolio queue, the append-only " +
            "event ledger, and run-state by reusing the existing collectManageStatus/collectRunPortfolio aggregators " +
            "-- no new join logic -- returning the same { rows, runPortfolio } shape `manage status --json` prints. " +
            "Read-only: never calls GitHub, never mutates local stores. Takes no arguments.",
        inputSchema: {},
    }, async () => {
        const ownsPortfolioQueue = options.initPortfolioQueue === undefined;
        const ownsEventLedger = options.initEventLedger === undefined;
        const ownsRunStateStore = options.initRunStateStore === undefined;
        const portfolioQueue = (options.initPortfolioQueue ?? initPortfolioQueueStore)();
        const eventLedger = (options.initEventLedger ?? initEventLedger)();
        const runStateStore = (options.initRunStateStore ?? initRunStateStore)();
        try {
            // The injection seams above are typed to the minimal read surface each tool touches (mirroring the
            // dashboard tool's `{ listQueue }` seam), but collectManageStatus/collectRunPortfolio's declared source
            // types name the full stores. Both aggregators only ever read (listQueue/getRunState/listRunStates) at
            // runtime -- exactly what the seam guarantees -- so widening the resolved stores back to the store types
            // the signatures ask for is sound; it never reaches a write/lifecycle method the minimal seam omits.
            const rows = collectManageStatus({
                portfolioQueue: portfolioQueue,
                eventLedger,
            });
            const runPortfolio = collectRunPortfolio({
                portfolioQueue: portfolioQueue,
                eventLedger,
                runStateStore: runStateStore,
            });
            return { content: [{ type: "text", text: JSON.stringify({ rows, runPortfolio }) }] };
        }
        finally {
            if (ownsPortfolioQueue)
                portfolioQueue.close();
            if (ownsEventLedger)
                eventLedger.close();
            if (ownsRunStateStore)
                runStateStore.close();
        }
    });
    server.registerTool("loopover_miner_list_claims", {
        description: "Read-only listing of the local claim ledger: which issues this miner has claimed (repo, issue number, " +
            "status, claimed-at, note). Optional repoFullName/status filters pass through to the existing listClaims " +
            "query. Exposes no claim/release mutation and no conflict-resolution logic.",
        inputSchema: {
            repoFullName: z.string().optional(),
            status: z.enum(CLAIM_STATUSES).optional(),
        },
    }, async ({ repoFullName, status }) => {
        const ownsLedger = options.openClaimLedger === undefined;
        const ledger = (options.openClaimLedger ?? openClaimLedger)();
        try {
            const filter = {};
            if (repoFullName !== undefined)
                filter.repoFullName = repoFullName;
            if (status !== undefined)
                filter.status = status;
            return { content: [{ type: "text", text: JSON.stringify(ledger.listClaims(filter)) }] };
        }
        finally {
            if (ownsLedger)
                ledger.close();
        }
    });
    server.registerTool("loopover_miner_get_audit_feed", {
        description: "Read-only, metadata-only audit feed from the local append-only event ledger: eventType, repoFullName, " +
            "outcome, actor, detail, and createdAt per row. Wraps collectEventLedgerAuditFeed() (no new query logic) — " +
            "the same read filters as `loopover-miner ledger list` (--repo, --since, --type). Never returns " +
            "payload_json or other raw ledger columns; never writes to the ledger.",
        inputSchema: auditFeedInputSchema,
    }, async (input) => {
        const ownsLedger = options.initEventLedger === undefined;
        const eventLedger = (options.initEventLedger ?? initEventLedger)();
        try {
            // zod's `.optional()` widens each field to `string | undefined`, whereas normalizeAuditFeedMcpFilter's
            // input type spells the same absent-field slot as `string | null`; the normalizer treats missing and
            // null identically, so narrowing the parsed input to that shape is exact, not a behavior change.
            const filter = normalizeAuditFeedMcpFilter((input ?? {}));
            const feed = collectEventLedgerAuditFeed(eventLedger, filter);
            return { content: [{ type: "text", text: JSON.stringify(feed) }] };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            error: error instanceof Error ? error.message : String(error),
                        }),
                    },
                ],
                isError: true,
            };
        }
        finally {
            if (ownsLedger)
                eventLedger.close();
        }
    });
    server.registerTool("loopover_miner_get_run_state", {
        description: "Read-only per-repo miner run-state (idle/discovering/planning/preparing). Pass repoFullName for a single " +
            "repo (a null state means none has been recorded for it yet), or omit it to list every repo's state. The " +
            "read-only analog of ORB's loopover_get_automation_state; adds no state-set or mutation capability.",
        inputSchema: {
            repoFullName: z.string().min(1).optional(),
        },
    }, async ({ repoFullName }) => {
        const ownsStore = options.initRunStateStore === undefined;
        const store = (options.initRunStateStore ?? initRunStateStore)();
        try {
            const result = repoFullName === undefined
                ? { states: store.listRunStates() }
                : { repoFullName, state: store.getRunState(repoFullName) };
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        finally {
            if (ownsStore)
                store.close();
        }
    });
    server.registerTool("loopover_miner_list_plans", {
        description: "Read-only list of the miner's PERSISTED plan store (planId, plan DAG, status, updatedAt), optionally " +
            "filtered by status. Wraps plan-store.js's existing listPlans query -- no new logic, no mutation. NOTE: " +
            "this is the store-backed AMS plan store; it is distinct from ORB's stateless loopover_plan_status " +
            "tool, which reads the caller's in-memory plan object rather than any persisted store.",
        inputSchema: {
            status: z.enum(PLAN_STATUSES).optional(),
        },
    }, async ({ status }) => {
        const ownsStore = options.openPlanStore === undefined;
        const store = (options.openPlanStore ?? openPlanStore)();
        try {
            const filter = {};
            if (status !== undefined)
                filter.status = status;
            return { content: [{ type: "text", text: JSON.stringify(store.listPlans(filter)) }] };
        }
        finally {
            if (ownsStore)
                store.close();
        }
    });
    server.registerTool("loopover_miner_get_plan", {
        description: "Read-only fetch of one persisted plan record by planId (the full plan DAG, status, updatedAt), or an " +
            "explicit { planId, found: false } for an unknown id. Wraps plan-store.js's existing loadPlan lookup -- " +
            "no mutation, no DAG/planning logic. Store-backed AMS plan store; distinct from ORB's stateless " +
            "loopover_plan_status tool.",
        inputSchema: {
            planId: z.string().min(1),
        },
    }, async ({ planId }) => {
        const ownsStore = options.openPlanStore === undefined;
        const store = (options.openPlanStore ?? openPlanStore)();
        try {
            const plan = store.loadPlan(planId);
            const result = plan === null ? { planId, found: false } : { found: true, plan };
            return { content: [{ type: "text", text: JSON.stringify(result) }] };
        }
        finally {
            if (ownsStore)
                store.close();
        }
    });
    server.registerTool("loopover_miner_get_governor_decisions", {
        description: "Read-only projection of the governor decision log: id, ts, eventType, repoFullName, actionClass, " +
            "decision, reason per row. This projection INTENTIONALLY EXCLUDES the internal/sensitive payload column " +
            "(reputation / self-plagiarism / budget state) by construction -- governor-ledger.js reads it with an " +
            "explicit named-column SELECT, never SELECT *. Optional repoFullName filter (the only filter the ledger " +
            "supports natively). Read-only; never writes to the ledger.",
        inputSchema: {
            repoFullName: z.string().min(1).optional(),
        },
    }, async ({ repoFullName }) => {
        const ownsLedger = options.initGovernorLedger === undefined;
        const ledger = (options.initGovernorLedger ?? initGovernorLedger)();
        try {
            const filter = {};
            if (repoFullName !== undefined)
                filter.repoFullName = repoFullName;
            return { content: [{ type: "text", text: JSON.stringify(ledger.readGovernorDecisions(filter)) }] };
        }
        finally {
            if (ownsLedger)
                ledger.close();
        }
    });
    server.registerTool("loopover_miner_status", {
        description: "Read-only miner status + doctor diagnostics. Returns { status, doctor }: status = package/engine versions " +
            "(+ skew), node version, state-dir path, config-file path, and the resolved coding-agent driver (provider " +
            "name, the model ENV-VAR NAME -- never its value -- and a CLI-present boolean); doctor = the same checks " +
            "`loopover-miner doctor` runs (Docker/CLI presence, config validity, ...) as { name, ok, detail }. Reuses " +
            "collectStatus/runDoctorChecks so it can never drift from the CLI. Only names / booleans / paths -- never " +
            "any env-var value, token, key, or credential. Read-only; no writes or state changes.",
        inputSchema: {},
    }, async () => {
        const status = (options.collectStatus ?? collectStatus)();
        const doctor = (options.runDoctorChecks ?? runDoctorChecks)();
        return { content: [{ type: "text", text: JSON.stringify({ status, doctor }) }] };
    });
    server.registerTool("loopover_miner_get_calibration_report", {
        description: "Read-only miner-local prediction-accuracy report: per-project merge/close precision, joining this " +
            "miner's own recorded gate predictions (prediction ledger) with the realized PR outcomes it later " +
            "observed (pr_outcome events). Wraps calibration-cli.js's existing toPredictionRecords/toOutcomeRecords " +
            "mappers and calibration.js's buildCalibrationReport composer -- no new join/scoring logic, no mutation. " +
            "Strictly local and offline; distinct from ORB's hosted, maintainer-authenticated " +
            "loopover_get_outcome_calibration tool, which reads a different (D1) data source. Takes no arguments.",
        inputSchema: {},
    }, async () => {
        const ownsPredictionLedger = options.initPredictionLedger === undefined;
        const ownsEventLedger = options.initEventLedger === undefined;
        let predictionLedger;
        let eventLedger;
        try {
            predictionLedger = (options.initPredictionLedger ?? initPredictionLedger)();
            eventLedger = (options.initEventLedger ?? initEventLedger)();
            const report = buildCalibrationReport(toPredictionRecords(predictionLedger.readPredictions()), toOutcomeRecords(eventLedger.readEvents()));
            return { content: [{ type: "text", text: JSON.stringify(report) }] };
        }
        finally {
            if (ownsPredictionLedger)
                predictionLedger?.close();
            if (ownsEventLedger)
                eventLedger?.close();
        }
    });
    return server;
}
// Start the stdio transport only when executed directly as the bin, not when imported by a test.
// realpathSync on both sides resolves the npm bin symlink so a global/npx install still matches.
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
/* v8 ignore start -- process entry point: this guard is specifically what makes it unreachable when the
 * module is imported (every existing MCP tool test does exactly that, per this file's own comment above), so
 * it can never be true in this test run's own process. createMinerMcpServer() itself is fully exercised by
 * those tests; this is only the top-level "am I actually invoked as the bin" wiring, mirroring
 * loopover-miner.js's identical exemption and src/server.ts's in codecov.yml. */
if (invokedPath && invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
    // Previously this bin had NO crash safety net beyond the startup .catch() below -- an exception thrown while
    // handling an MCP tool call, after the server was already connected, had nowhere to go (#6011). Wire in the
    // same opt-in Sentry + signal/crash handling loopover-miner.js already gets, sharing process-lifecycle.js.
    try {
        loadMinerFileSecrets();
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
    }
    await initMinerSentry(process.env);
    installCliSignalHandlers({ captureError: captureMinerErrorAndFlush });
    createMinerMcpServer()
        .connect(new StdioServerTransport())
        .catch(async (error) => {
        console.error(error);
        // Awaited so the captured event has a chance to actually reach Sentry before exit() tears the process
        // down -- a bare synchronous capture only queues it (#6011 follow-up).
        await captureMinerErrorAndFlush(error, { kind: "mcp_startup_connect_failed" });
        process.exit(1);
    });
}
/* v8 ignore stop */
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibG9vcG92ZXItbWluZXItbWNwLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsibG9vcG92ZXItbWluZXItbWNwLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7QUFDQSxPQUFPLEVBQUUsWUFBWSxFQUFFLFlBQVksRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUNyRCxPQUFPLEVBQUUsT0FBTyxFQUFFLElBQUksRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUMxQyxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sVUFBVSxDQUFDO0FBQ3pDLE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSx5Q0FBeUMsQ0FBQztBQUNwRSxPQUFPLEVBQUUsb0JBQW9CLEVBQUUsTUFBTSwyQ0FBMkMsQ0FBQztBQUNqRixPQUFPLEVBQUUsQ0FBQyxFQUFFLE1BQU0sS0FBSyxDQUFDO0FBQ3hCLE9BQU8sRUFBRSxjQUFjLEVBQUUsZUFBZSxFQUFFLE1BQU0sd0JBQXdCLENBQUM7QUFDekUsT0FBTyxFQUVMLDJCQUEyQixFQUMzQiwyQkFBMkIsR0FDNUIsTUFBTSw0QkFBNEIsQ0FBQztBQUNwQyxPQUFPLEVBQUUsZUFBZSxFQUFvQixNQUFNLHdCQUF3QixDQUFDO0FBQzNFLE9BQU8sRUFBRSxtQkFBbUIsRUFBRSxtQkFBbUIsRUFBRSxNQUFNLHlCQUF5QixDQUFDO0FBQ25GLE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxNQUFNLCtCQUErQixDQUFDO0FBQzFFLE9BQU8sRUFBRSx1QkFBdUIsRUFBNEIsTUFBTSwyQkFBMkIsQ0FBQztBQUM5RixPQUFPLEVBQUUsaUJBQWlCLEVBQXNCLE1BQU0scUJBQXFCLENBQUM7QUFDNUUsT0FBTyxFQUFFLGFBQWEsRUFBRSxhQUFhLEVBQUUsTUFBTSxzQkFBc0IsQ0FBQztBQUNwRSxPQUFPLEVBQUUsa0JBQWtCLEVBQUUsTUFBTSwyQkFBMkIsQ0FBQztBQUMvRCxPQUFPLEVBQUUsYUFBYSxFQUFFLGVBQWUsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQ2xFLE9B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