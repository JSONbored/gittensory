// `loopover-miner purge` (#5564, #6599): an explicit, operator-invoked right-to-be-forgotten path across the local
// ledgers. Deletes every row for one repo from the stores that have a real `repoColumn` (claim-ledger,
// event-ledger, governor-ledger, prediction-ledger, portfolio-queue, run-state, contribution-profile-cache, and
// governor-state's two repo-scoped tables — #7091), via each store's own `purgeByRepo` method (which reuses
// `store-maintenance.js`'s shared, identifier-guarded `purgeStoreByRepo`).
// `attempt-log.js` is deliberately reported as not-purgeable rather than silently skipped or approximated: its
// payload is a free-form `Record<string, unknown>` with no dedicated repo column, so a precise per-repo match
// isn't possible there without risking false matches -- see store-maintenance.js's own purge-spec doc comment.
//
// Every purge is audit-observable by design (#5564's own acceptance criteria): the real (non-dry-run) path
// always prints a per-store summary, even under --json, so a purge can never be silent. A failure in one store
// does not prevent reporting what succeeded in the others -- see purgeOneStore's own per-store try/catch.
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openClaimLedger, resolveClaimLedgerDbPath } from "./claim-ledger.js";
import { initEventLedger, resolveEventLedgerDbPath } from "./event-ledger.js";
import { initGovernorLedger, resolveGovernorLedgerDbPath } from "./governor-ledger.js";
import { initPredictionLedger, resolvePredictionLedgerDbPath } from "./prediction-ledger.js";
import { initPortfolioQueueStore, resolvePortfolioQueueDbPath } from "./portfolio-queue.js";
import { initRunStateStore, resolveRunStateDbPath } from "./run-state.js";
import { initContributionProfileCache, resolveContributionProfileCacheDbPath } from "./contribution-profile-cache.js";
import { openGovernorState, resolveGovernorStateDbPath } from "./governor-state.js";
import { initPolicyVerdictCacheStore, resolvePolicyVerdictCacheDbPath } from "./policy-verdict-cache.js";
import { resolveAttemptLogDbPath } from "./attempt-log.js";
import { CLAIM_LEDGER_PURGE_SPEC, EVENT_LEDGER_PURGE_SPEC, GOVERNOR_LEDGER_PURGE_SPEC, PREDICTION_LEDGER_PURGE_SPEC, PORTFOLIO_QUEUE_PURGE_SPEC, RUN_STATE_PURGE_SPEC, CONTRIBUTION_PROFILE_CACHE_PURGE_SPEC, GOVERNOR_REPUTATION_HISTORY_PURGE_SPEC, GOVERNOR_OWN_SUBMISSIONS_PURGE_SPEC, POLICY_VERDICT_CACHE_PURGE_SPEC, countStoreByRepo, describeError, } from "./store-maintenance.js";
import { argsWantJson, reportCliFailure } from "./cli-error.js";
const PURGE_USAGE = "Usage: loopover-miner purge --repo <owner/repo> [--dry-run] [--json]";
export const ATTEMPT_LOG_NOT_PURGEABLE_NOTE = "attempt-log has no repoFullName column and cannot be purged by repo (#5564); its rows are unaffected";
const REAL_PURGE_TARGETS = [
    { name: "claim-ledger", optionKey: "openClaimLedger", opener: openClaimLedger, resolveDbPath: resolveClaimLedgerDbPath, spec: CLAIM_LEDGER_PURGE_SPEC },
    { name: "event-ledger", optionKey: "initEventLedger", opener: initEventLedger, resolveDbPath: resolveEventLedgerDbPath, spec: EVENT_LEDGER_PURGE_SPEC },
    { name: "governor-ledger", optionKey: "initGovernorLedger", opener: initGovernorLedger, resolveDbPath: resolveGovernorLedgerDbPath, spec: GOVERNOR_LEDGER_PURGE_SPEC },
    { name: "prediction-ledger", optionKey: "initPredictionLedger", opener: initPredictionLedger, resolveDbPath: resolvePredictionLedgerDbPath, spec: PREDICTION_LEDGER_PURGE_SPEC },
    { name: "portfolio-queue", optionKey: "initPortfolioQueueStore", opener: initPortfolioQueueStore, resolveDbPath: resolvePortfolioQueueDbPath, spec: PORTFOLIO_QUEUE_PURGE_SPEC },
    { name: "run-state", optionKey: "initRunStateStore", opener: initRunStateStore, resolveDbPath: resolveRunStateDbPath, spec: RUN_STATE_PURGE_SPEC },
    { name: "contribution-profile-cache", optionKey: "initContributionProfileCache", opener: initContributionProfileCache, resolveDbPath: resolveContributionProfileCacheDbPath, spec: CONTRIBUTION_PROFILE_CACHE_PURGE_SPEC },
    // governor-state holds TWO repo-scoped tables in one DB file; its store.purgeByRepo deletes both against a
    // single handle (never reopening the file), and its dry-run count sums both via `specs` (#7091).
    { name: "governor-state", optionKey: "openGovernorState", opener: openGovernorState, resolveDbPath: resolveGovernorStateDbPath, specs: [GOVERNOR_REPUTATION_HISTORY_PURGE_SPEC, GOVERNOR_OWN_SUBMISSIONS_PURGE_SPEC] },
    { name: "policy-verdict-cache", optionKey: "initPolicyVerdictCacheStore", opener: initPolicyVerdictCacheStore, resolveDbPath: resolvePolicyVerdictCacheDbPath, spec: POLICY_VERDICT_CACHE_PURGE_SPEC },
];
function parseRepoArg(value, usage) {
    if (!value)
        return { error: usage };
    const trimmed = value.trim();
    const [owner, repo, extra] = trimmed.split("/");
    if (!owner || !repo || extra !== undefined) {
        return { error: "Repository must be in owner/repo form." };
    }
    return { repoFullName: `${owner}/${repo}` };
}
export function parsePurgeArgs(args) {
    const options = {
        json: false,
        dryRun: false,
        repoFullName: null,
    };
    for (let index = 0; index < args.length; index += 1) {
        const token = args[index];
        if (token === "--json") {
            options.json = true;
            continue;
        }
        if (token === "--dry-run") {
            options.dryRun = true;
            continue;
        }
        if (token === "--repo") {
            const repoArg = args[index + 1];
            // Only the flag-look-alike case is checked here ("--repo --json") -- a genuinely missing value (repoArg
            // undefined) falls through to parseRepoArg's own `!value` guard below, the single source of truth for that.
            if (repoArg !== undefined && repoArg.startsWith("-"))
                return { error: PURGE_USAGE };
            const repo = parseRepoArg(repoArg, PURGE_USAGE);
            if ("error" in repo)
                return repo;
            options.repoFullName = repo.repoFullName;
            index += 1;
            continue;
        }
        return { error: `Unknown option: ${token}` };
    }
    if (!options.repoFullName)
        return { error: PURGE_USAGE };
    return { json: options.json, dryRun: options.dryRun, repoFullName: options.repoFullName };
}
/** Read-only row count against an on-disk store file, for --dry-run. `{ readOnly: true }` (camelCase) is the
 *  only option node:sqlite recognizes for a driver-enforced read-only connection -- the lowercase `readonly`
 *  key is silently ignored. Never touches a store that doesn't exist yet (opening one -- even read-only --
 *  requires the file to already be there; a dry run must make zero writes). */
function countExistingRows(dbPath, countFn) {
    if (!existsSync(dbPath))
        return 0;
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        return countFn(db);
    }
    finally {
        db.close();
    }
}
function renderDryRunSummary(result) {
    const purgeableLine = result.stores
        .map((entry) => `${entry.store}=${entry.wouldPurge}`)
        .join(", ");
    return [
        `DRY RUN: would purge ${result.repoFullName} from: ${purgeableLine}. No writes were made.`,
        `${ATTEMPT_LOG_NOT_PURGEABLE_NOTE} (${result.attemptLogTotalRows} total row(s) currently in attempt-log, all repos).`,
    ].join("\n");
}
export function runPurgeDryRun(parsed, options = {}) {
    const resolveDbPaths = options.resolveDbPaths ?? {};
    const stores = REAL_PURGE_TARGETS.map((target) => {
        const dbPath = (resolveDbPaths[target.name] ?? target.resolveDbPath)();
        // A target scopes one table (`spec`) or -- for governor-state -- several in one file (`specs`); sum the
        // per-table counts against the single read-only handle so the preview matches what a real purge removes.
        // Every REAL_PURGE_TARGETS entry declares exactly one of the two, so `target.spec` is always set here.
        const specs = target.specs ?? [target.spec];
        try {
            const wouldPurge = countExistingRows(dbPath, (db) => specs.reduce((sum, spec) => sum + countStoreByRepo(db, spec, parsed.repoFullName), 0));
            return { store: target.name, wouldPurge };
        }
        catch (error) {
            return { store: target.name, wouldPurge: null, error: describeError(error) };
        }
    });
    const attemptLogDbPath = (resolveDbPaths["attempt-log"] ?? resolveAttemptLogDbPath)();
    const attemptLogTotalRows = countExistingRows(attemptLogDbPath, (db) => Number(db.prepare("SELECT COUNT(*) AS count FROM attempt_log_events").get().count));
    const result = {
        outcome: "dry_run",
        repoFullName: parsed.repoFullName,
        stores,
        attemptLogNote: ATTEMPT_LOG_NOT_PURGEABLE_NOTE,
        attemptLogTotalRows,
    };
    if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
    }
    else {
        console.log(renderDryRunSummary(result));
    }
    return 0;
}
function purgeOneStore(target, options, repoFullName) {
    const ownsStore = options[target.optionKey] === undefined;
    let store;
    try {
        store = (options[target.optionKey] ?? target.opener)();
        const purged = store.purgeByRepo(repoFullName);
        return { store: target.name, purged };
    }
    catch (error) {
        return { store: target.name, purged: null, error: describeError(error) };
    }
    finally {
        if (ownsStore)
            store?.close();
    }
}
function renderPurgeSummary(summary) {
    const perStore = summary.stores
        .map((entry) => {
        if ("error" in entry)
            return `${entry.store}=ERROR(${entry.error})`;
        if (entry.purged === null)
            return `${entry.store}=skipped`;
        return `${entry.store}=${entry.purged}`;
    })
        .join(", ");
    return [
        `Purged ${summary.totalPurged} row(s) for ${summary.repoFullName} at ${summary.purgedAt}: ${perStore}.`,
        ATTEMPT_LOG_NOT_PURGEABLE_NOTE,
    ].join(" ");
}
export function runPurge(args, options = {}) {
    const parsed = parsePurgeArgs(args);
    if ("error" in parsed) {
        return reportCliFailure(argsWantJson(args), parsed.error);
    }
    if (parsed.dryRun) {
        return runPurgeDryRun(parsed, options);
    }
    const perStoreResults = REAL_PURGE_TARGETS.map((target) => purgeOneStore(target, options, parsed.repoFullName));
    perStoreResults.push({ store: "attempt-log", purged: null, note: ATTEMPT_LOG_NOT_PURGEABLE_NOTE });
    const totalPurged = perStoreResults.reduce((sum, entry) => sum + (entry.purged ?? 0), 0);
    const hadError = perStoreResults.some((entry) => "error" in entry);
    const summary = {
        outcome: hadError ? "partial" : "purged",
        repoFullName: parsed.repoFullName,
        totalPurged,
        stores: perStoreResults,
        purgedAt: new Date().toISOString(),
    };
    // Audit-observable by design (#5564): print the summary in BOTH the success and partial-failure case, so a
    // purge -- or a purge that only partly succeeded -- is never silent.
    if (parsed.json) {
        console.log(JSON.stringify(summary, null, 2));
    }
    else {
        console.log(renderPurgeSummary(summary));
    }
    return hadError ? 2 : 0;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHVyZ2UtY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicHVyZ2UtY2xpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLG1IQUFtSDtBQUNuSCx1R0FBdUc7QUFDdkcsZ0hBQWdIO0FBQ2hILDRHQUE0RztBQUM1RywyRUFBMkU7QUFDM0UsK0dBQStHO0FBQy9HLDhHQUE4RztBQUM5RywrR0FBK0c7QUFDL0csRUFBRTtBQUNGLDJHQUEyRztBQUMzRywrR0FBK0c7QUFDL0csMEdBQTBHO0FBQzFHLE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFDckMsT0FBTyxFQUFFLFlBQVksRUFBRSxNQUFNLGFBQWEsQ0FBQztBQUMzQyxPQUFPLEVBQUUsZUFBZSxFQUFFLHdCQUF3QixFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFFOUUsT0FBTyxFQUFFLGVBQWUsRUFBRSx3QkFBd0IsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBRTlFLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSwyQkFBMkIsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBRXZGLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSw2QkFBNkIsRUFBRSxNQUFNLHdCQUF3QixDQUFDO0FBRTdGLE9BQU8sRUFBRSx1QkFBdUIsRUFBRSwyQkFBMkIsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBRTVGLE9BQU8sRUFBRSxpQkFBaUIsRUFBRSxxQkFBcUIsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBRTFFLE9BQU8sRUFBRSw0QkFBNEIsRUFBRSxxQ0FBcUMsRUFBRSxNQUFNLGlDQUFpQyxDQUFDO0FBRXRILE9BQU8sRUFBRSxpQkFBaUIsRUFBRSwwQkFBMEIsRUFBRSxNQUFNLHFCQUFxQixDQUFDO0FBRXBGLE9BQU8sRUFBRSwyQkFBMkIsRUFBRSwrQkFBK0IsRUFBRSxNQUFNLDJCQUEyQixDQUFDO0FBRXpHLE9BQU8sRUFBRSx1QkFBdUIsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQzNELE9BQU8s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