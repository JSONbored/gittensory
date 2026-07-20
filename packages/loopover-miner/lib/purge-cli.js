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
    const options = { json: false, dryRun: false, repoFullName: null };
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
    const injected = options[target.optionKey];
    const ownsStore = injected === undefined;
    let store;
    try {
        store = (injected ?? target.opener)();
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
        if ("error" in entry && entry.error !== undefined)
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
    const hadError = perStoreResults.some((entry) => "error" in entry && entry.error !== undefined);
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHVyZ2UtY2xpLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicHVyZ2UtY2xpLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLG1IQUFtSDtBQUNuSCx1R0FBdUc7QUFDdkcsZ0hBQWdIO0FBQ2hILDRHQUE0RztBQUM1RywyRUFBMkU7QUFDM0UsK0dBQStHO0FBQy9HLDhHQUE4RztBQUM5RywrR0FBK0c7QUFDL0csRUFBRTtBQUNGLDJHQUEyRztBQUMzRywrR0FBK0c7QUFDL0csMEdBQTBHO0FBQzFHLE9BQU8sRUFBRSxVQUFVLEVBQUUsTUFBTSxTQUFTLENBQUM7QUFDckMsT0FBTyxFQUFFLFlBQVksRUFBRSxNQUFNLGFBQWEsQ0FBQztBQUMzQyxPQUFPLEVBQUUsZUFBZSxFQUFFLHdCQUF3QixFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFDOUUsT0FBTyxFQUFFLGVBQWUsRUFBRSx3QkFBd0IsRUFBRSxNQUFNLG1CQUFtQixDQUFDO0FBQzlFLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSwyQkFBMkIsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBQ3ZGLE9BQU8sRUFBRSxvQkFBb0IsRUFBRSw2QkFBNkIsRUFBRSxNQUFNLHdCQUF3QixDQUFDO0FBQzdGLE9BQU8sRUFBRSx1QkFBdUIsRUFBRSwyQkFBMkIsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBQzVGLE9BQU8sRUFBRSxpQkFBaUIsRUFBRSxxQkFBcUIsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBQzFFLE9BQU8sRUFBRSw0QkFBNEIsRUFBRSxxQ0FBcUMsRUFBRSxNQUFNLGlDQUFpQyxDQUFDO0FBQ3RILE9BQU8sRUFBRSxpQkFBaUIsRUFBRSwwQkFBMEIsRUFBRSxNQUFNLHFCQUFxQixDQUFDO0FBQ3BGLE9BQU8sRUFBRSwyQkFBMkIsRUFBRSwrQkFBK0IsRUFBRSxNQUFNLDJCQUEyQixDQUFDO0FBQ3pHLE9BQU8sRUFBRSx1QkFBdUIsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQzNELE9BQU8s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