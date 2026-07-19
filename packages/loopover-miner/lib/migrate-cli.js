// Proactive schema-migration runner for the miner's local SQLite stores (#4871). Every store already applies
// its own pending migrations (schema-version.js's applySchemaMigrations) as a side effect of being opened by
// whatever command happens to touch it first -- this command instead lets an operator PROACTIVELY bring every
// known store's EXISTING on-disk file up to date in one pass (e.g. right after upgrading, or before starting a
// fleet), without needing to guess which command happens to touch which store first. Mirrors status.js's
// storeIntegrityChecks [name, resolve*DbPath(env)] store list exactly (same eleven stores `doctor` already
// covers, #6768), but actually OPENS each store (rather than a read-only integrity probe) so its real open/init
// function's migration path runs for real. A store file that does not exist yet is skipped, not created --
// "migrate" brings existing files up to date; it is not another way to bootstrap fresh state (that's `init`).
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { readSchemaVersion } from "./schema-version.js";
import { argsWantJson, reportCliFailure } from "./cli-error.js";
import { openClaimLedger, resolveClaimLedgerDbPath } from "./claim-ledger.js";
import { initEventLedger, resolveEventLedgerDbPath } from "./event-ledger.js";
import { initGovernorLedger, resolveGovernorLedgerDbPath } from "./governor-ledger.js";
import { initPredictionLedger, resolvePredictionLedgerDbPath } from "./prediction-ledger.js";
import { initPortfolioQueueStore, resolvePortfolioQueueDbPath } from "./portfolio-queue.js";
import { initRunStateStore, resolveRunStateDbPath } from "./run-state.js";
import { openPlanStore, resolvePlanStoreDbPath } from "./plan-store.js";
import { openGovernorState, resolveGovernorStateDbPath } from "./governor-state.js";
import { initAttemptLog, resolveAttemptLogDbPath } from "./attempt-log.js";
import { openReplaySnapshotStore, resolveReplaySnapshotDbPath } from "./replay-snapshot.js";
import { openWorktreeAllocator, resolveWorktreeAllocatorDbPath } from "./worktree-allocator.js";
import { initContributionProfileCache, resolveContributionProfileCacheDbPath } from "./contribution-profile-cache.js";
import { initPolicyVerdictCacheStore, resolvePolicyVerdictCacheDbPath } from "./policy-verdict-cache.js";
import { initPolicyDocCacheStore, resolvePolicyDocCacheDbPath } from "./policy-doc-cache.js";
const MIGRATE_USAGE = "Usage: loopover-miner migrate [--json]";
const STORES = [
    { name: "event-ledger", resolveDbPath: resolveEventLedgerDbPath, open: initEventLedger },
    { name: "governor-ledger", resolveDbPath: resolveGovernorLedgerDbPath, open: initGovernorLedger },
    { name: "prediction-ledger", resolveDbPath: resolvePredictionLedgerDbPath, open: initPredictionLedger },
    { name: "portfolio-queue", resolveDbPath: resolvePortfolioQueueDbPath, open: initPortfolioQueueStore },
    { name: "claim-ledger", resolveDbPath: resolveClaimLedgerDbPath, open: openClaimLedger },
    { name: "run-state", resolveDbPath: resolveRunStateDbPath, open: initRunStateStore },
    { name: "plan-store", resolveDbPath: resolvePlanStoreDbPath, open: openPlanStore },
    { name: "governor-state", resolveDbPath: resolveGovernorStateDbPath, open: openGovernorState },
    { name: "attempt-log", resolveDbPath: resolveAttemptLogDbPath, open: initAttemptLog },
    {
        name: "replay-snapshot",
        // resolveReplaySnapshotDbPath's own (not-yet-converted) .d.ts types `env` as `NodeJS.ProcessEnv`, unlike
        // every sibling resolver here (`Record<string, string | undefined>`) -- a pre-existing inconsistency, not
        // introduced by this batch. process.env genuinely satisfies both shapes at runtime, so this cast is safe.
        resolveDbPath: resolveReplaySnapshotDbPath,
        open: openReplaySnapshotStore,
    },
    {
        name: "worktree-allocator",
        resolveDbPath: resolveWorktreeAllocatorDbPath,
        open: (dbPath) => openWorktreeAllocator({ dbPath }),
    },
    {
        name: "contribution-profile",
        resolveDbPath: resolveContributionProfileCacheDbPath,
        open: initContributionProfileCache,
    },
    { name: "policy-verdict-cache", resolveDbPath: resolvePolicyVerdictCacheDbPath, open: initPolicyVerdictCacheStore },
    { name: "policy-doc-cache", resolveDbPath: resolvePolicyDocCacheDbPath, open: initPolicyDocCacheStore },
];
/** Read a store file's stamped schema version without ever creating it -- matches checkStoreIntegrity's
 *  "not created yet" convention: an absent file has nothing to report a version for. */
function peekSchemaVersion(dbPath) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
        return readSchemaVersion(db);
    }
    finally {
        db.close();
    }
}
/**
 * Bring one store's EXISTING on-disk schema up to date. Never throws: a store that fails to open/migrate is
 * reported as a failed result so one bad store cannot abort the whole sweep, matching doctor's per-store
 * isolation. A store file that does not exist yet is reported as a clean skip (nothing to migrate), never
 * created as a side effect of running this command.
 */
function migrateStore({ name, resolveDbPath, open }, env) {
    const dbPath = resolveDbPath(env);
    if (!existsSync(dbPath)) {
        return {
            name,
            dbPath,
            ok: true,
            status: "skipped",
            detail: "not created yet",
            versionBefore: null,
            versionAfter: null,
        };
    }
    // versionBefore is read INSIDE the same try as the migration itself: a corrupted file can throw on this very
    // first read (a store that can't even be opened has no readable version either), and that must still surface
    // as one failed store result rather than an uncaught exception aborting the whole sweep.
    let versionBefore = null;
    try {
        versionBefore = peekSchemaVersion(dbPath);
        const store = open(dbPath);
        store.close();
        const versionAfter = peekSchemaVersion(dbPath);
        return {
            name,
            dbPath,
            ok: true,
            status: versionAfter > versionBefore ? "migrated" : "up-to-date",
            detail: `v${versionBefore} -> v${versionAfter}`,
            versionBefore,
            versionAfter,
        };
    }
    catch (error) {
        // applySchemaMigrations applies AND stamps each migration in its OWN transaction, so a failure part-way
        // through a multi-migration sequence leaves the file at the LAST fully-applied version -- genuinely AHEAD
        // of versionBefore. Re-read the real on-disk version instead of reporting a misleading "nothing changed".
        // Guarded by its own try: the failure may itself be an unreadable/corrupt file (the same reason
        // versionBefore can still be null here), in which case the pre-failure reading is all we can honestly
        // report.
        let versionAfter = versionBefore;
        try {
            versionAfter = peekSchemaVersion(dbPath);
        }
        catch {
            versionAfter = versionBefore;
        }
        return {
            name,
            dbPath,
            ok: false,
            status: "failed",
            detail: error instanceof Error ? error.message : String(error),
            versionBefore,
            versionAfter,
        };
    }
}
/** `stores` is injectable so tests can exercise a store descriptor's failure paths (e.g. a non-Error throw)
 *  without depending on real node:sqlite error shapes; defaults to the real seven-store list. */
export function runMigrateChecks(env = process.env, stores = STORES) {
    return stores.map((store) => migrateStore(store, env));
}
export function runMigrate(args = [], env = process.env) {
    const json = argsWantJson(args);
    // Validated BEFORE any store is opened: a typo'd flag must fail fast rather than silently run a full
    // migration sweep that ignored what the operator actually typed (#5917). `--json` is the only flag this
    // command takes, so anything else -- an unrecognized flag or a stray positional -- is rejected.
    const unknown = args.find((token) => token !== "--json");
    if (unknown !== undefined)
        return reportCliFailure(json, `Unknown option: ${unknown}. ${MIGRATE_USAGE}`, 2);
    const results = runMigrateChecks(env);
    const failed = results.filter((result) => !result.ok);
    if (json) {
        console.log(JSON.stringify({ ok: failed.length === 0, stores: results }, null, 2));
    }
    else {
        for (const result of results) {
            console.log(`${result.ok ? result.status.padEnd(10) : "FAIL      "} ${result.name}: ${result.detail}`);
        }
        if (failed.length > 0)
            console.error(`migrate: ${failed.length} store(s) failed`);
    }
    return failed.length === 0 ? 0 : 1;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibWlncmF0ZS1jbGkuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJtaWdyYXRlLWNsaS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSw2R0FBNkc7QUFDN0csNkdBQTZHO0FBQzdHLDhHQUE4RztBQUM5RywrR0FBK0c7QUFDL0cseUdBQXlHO0FBQ3pHLDJHQUEyRztBQUMzRyxnSEFBZ0g7QUFDaEgsMkdBQTJHO0FBQzNHLDhHQUE4RztBQUM5RyxPQUFPLEVBQUUsVUFBVSxFQUFFLE1BQU0sU0FBUyxDQUFDO0FBQ3JDLE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSxhQUFhLENBQUM7QUFDM0MsT0FBTyxFQUFFLGlCQUFpQixFQUFFLE1BQU0scUJBQXFCLENBQUM7QUFDeEQsT0FBTyxFQUFFLFlBQVksRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLGdCQUFnQixDQUFDO0FBQ2hFLE9BQU8sRUFBRSxlQUFlLEVBQUUsd0JBQXdCLEVBQUUsTUFBTSxtQkFBbUIsQ0FBQztBQUM5RSxPQUFPLEVBQUUsZUFBZSxFQUFFLHdCQUF3QixFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFDOUUsT0FBTyxFQUFFLGtCQUFrQixFQUFFLDJCQUEyQixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFDdkYsT0FBTyxFQUFFLG9CQUFvQixFQUFFLDZCQUE2QixFQUFFLE1BQU0sd0JBQXdCLENBQUM7QUFDN0YsT0FBTyxFQUFFLHVCQUF1QixFQUFFLDJCQUEyQixFQUFFLE1BQU0sc0JBQXNCLENBQUM7QUFDNUYsT0FBTyxFQUFFLGlCQUFpQixFQUFFLHFCQUFxQixFQUFFLE1BQU0sZ0JBQWdCLENBQUM7QUFDMUUsT0FBTyxFQUFFLGFBQWEsRUFBRSxzQkFBc0IsRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBQ3hFLE9BQU8sRUFBRSxpQkFBaUIsRUFBRSwwQkFBMEIsRUFBRSxNQUFNLHFCQUFxQixDQUFDO0FBQ3BGLE9BQU8sRUFBRSxjQUFjLEVBQUUsdUJBQXVCLEVBQUUsTUFBTSxrQkFB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