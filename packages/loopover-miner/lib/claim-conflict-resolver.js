// Real claim-conflict resolution (#4848): the missing piece over claim-adjudication.js's own adjudicator,
// which is correct and well-tested in isolation but has no caller that assembles a REAL competing-claims set.
// checkSubmissionFreshness (submission-freshness-check.js) already catches the common case pre-submission --
// aborting before open_pr if another author's PR already references the issue -- but that check can only see
// what's PUBLIC at the moment it runs. Two miners racing closely enough that BOTH pass their own freshness
// check before either's PR exists yet is a genuine TOCTOU window freshness cannot close. This module is the
// POST-submission reconciliation for exactly that window: once THIS miner's PR is real and public, check
// whether ANOTHER open PR also claims the same issue and, if this miner's claim loses the election, close its
// own just-opened PR (never anyone else's) -- the write action the contributor-vs-maintainer safety framework
// keeps maintainer-only (#4833's own scope note), since it means the autonomous loop acts on a race-resolution
// decision with no human review.
//
// CLAIM-TIME ASYMMETRY (documented, not accidental): `self`'s claimedAt is the miner's OWN real local
// claim-ledger timestamp (claim-ledger.js, recorded before work even started). A competing PR's claimedAt uses
// its real GitHub `createdAt` instead -- the maintainer gate's own duplicate-winner election uses loopover
// server's "first observed this PR's linked-issue set" timestamp, but that requires a continuous, persistent
// observation history this stateless client-side tool does not have for a PR it doesn't own. `createdAt` is
// the best real, publicly-observable proxy available for someone else's PR -- live-issue-snapshot.js's own
// comment on `createdAt` explains this in more detail.
//
// EVENTUAL CONSISTENCY: this checks GitHub's live state after submission. A competing PR that exists but
// hasn't yet propagated through GitHub's own search/GraphQL indexing in the first instant would be invisible
// to a single check, so the live-state snapshot fetch is wrapped in a bounded retry-with-backoff (#6058):
// a few attempts with exponential backoff (following http-retry.js's convention), returning as soon as a
// competing claim is observed, and otherwise giving a late-propagating competitor time to surface before
// this miner is declared the winner. The write-authorization boundary (#4833) is unchanged.
import { adjudicateSoftClaim } from "./claim-adjudication.js";
import { buildClosePrSpec } from "@loopover/engine";
import { defaultRetryBackoffMs } from "./http-retry.js";
// Bounded retry for the post-submission live-state check (#6058): a few attempts give a competing PR that
// hasn't propagated through GitHub's search/GraphQL index yet time to surface, without an unbounded loop.
const DEFAULT_SNAPSHOT_MAX_ATTEMPTS = 3;
const defaultSnapshotSleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
/**
 * Assemble the real competing-claims set from a fetched LiveIssueSnapshot: every OTHER open PR referencing
 * the issue, excluding `selfPrNumber` and any PR authored by `minerLogin` itself (case-insensitive, mirrors
 * checkSubmissionFreshness's own author comparison -- a login can be echoed back with different casing).
 * Excluding same-author PRs is deliberate, not an edge case slipping through: a miner never competes against
 * its own work, so if this login somehow has ANOTHER open PR on the same issue (e.g. a retry after a crash
 * left a stale one behind), that PR is never treated as a competing claim to lose against -- only a genuinely
 * different claimant's PR can trigger a real close.
 * Pure given its inputs.
 *
 * @param {import("./submission-freshness-check.js").LiveIssueSnapshot | null | undefined} snapshot
 * @param {number} selfPrNumber
 * @param {string} minerLogin
 * @returns {import("./claim-adjudication.js").ObservedClaim[]}
 */
export function assembleCompetingClaims(snapshot, selfPrNumber, minerLogin) {
    const minerLoginKey = minerLogin.trim().toLowerCase();
    const referencingPrs = Array.isArray(snapshot?.referencingPrs) ? snapshot.referencingPrs : [];
    return referencingPrs
        .filter((pr) => pr.state === "open" && pr.number !== selfPrNumber)
        .filter((pr) => typeof pr.authorLogin !== "string" || pr.authorLogin.trim().toLowerCase() !== minerLoginKey)
        .map((pr) => ({ number: pr.number, claimedAt: pr.createdAt ?? null }));
}
/**
 * Resolve a real claim conflict for an already-submitted PR. Fails OPEN (never closes anything) when the live
 * snapshot can't be fetched -- an unavailable check is not evidence of a lost claim.
 *
 * @param {{ repoFullName: string, issueNumber: number, selfPrNumber: number, selfClaimedAt: string | null, minerLogin: string }} input
 * @param {{
 *   fetchLiveIssueSnapshot: (repoFullName: string, issueNumber: number) => Promise<import("./submission-freshness-check.js").LiveIssueSnapshot | null>,
 *   executeLocalWrite: (spec: import("@loopover/engine").LocalWriteActionSpec) => Promise<unknown>,
 * }} deps
 * @param {{ maxAttempts?: number, sleepFn?: (ms: number) => Promise<unknown>, backoffMs?: (attempt: number) => number }} [options]
 *   Bounded retry for the live-state snapshot fetch (#6058): up to `maxAttempts` (default 3) attempts with
 *   `backoffMs(attempt)` backoff between them, returning as soon as a competing claim is observed. Pure over
 *   the injected `sleepFn`/`backoffMs` -- no real timers in tests.
 * @returns {Promise<{
 *   checked: boolean,
 *   reason?: "live_state_unavailable",
 *   isWinner?: boolean,
 *   winnerNumber?: number | null,
 *   competingCount?: number,
 *   closeResult?: unknown,
 * }>}
 */
export async function resolveClaimConflict(input, deps, options = {}) {
    const maxAttempts = Number.isFinite(options.maxAttempts) && options.maxAttempts >= 1
        ? Math.floor(options.maxAttempts)
        : DEFAULT_SNAPSHOT_MAX_ATTEMPTS;
    const sleepFn = typeof options.sleepFn === "function" ? options.sleepFn : defaultSnapshotSleep;
    const backoffMs = typeof options.backoffMs === "function" ? options.backoffMs : defaultRetryBackoffMs;
    let snapshot = null;
    let competing = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let current;
        try {
            current = await deps.fetchLiveIssueSnapshot(input.repoFullName, input.issueNumber);
        }
        catch {
            current = null;
        }
        if (current && typeof current === "object") {
            snapshot = current;
            competing = assembleCompetingClaims(current, input.selfPrNumber, input.minerLogin);
            // A competing claim observed = GitHub's index has propagated it; stop retrying and act on it now.
            if (competing.length > 0)
                break;
        }
        // Back off before the next attempt (index-propagation lag / a transient fetch failure); never after the last.
        if (attempt < maxAttempts)
            await sleepFn(backoffMs(attempt));
    }
    if (!snapshot) {
        return { checked: false, reason: "live_state_unavailable" };
    }
    const adjudication = adjudicateSoftClaim({ number: input.selfPrNumber, claimedAt: input.selfClaimedAt }, competing);
    if (adjudication.isWinner) {
        return { checked: true, isWinner: true, winnerNumber: adjudication.winnerNumber, competingCount: competing.length };
    }
    const comment = adjudication.winnerNumber
        ? `Closing this PR: pull request #${adjudication.winnerNumber} claimed this issue first. This is an automated soft-claim conflict resolution -- no action needed from you.`
        : `Closing this PR: another open pull request already claims this issue. This is an automated soft-claim conflict resolution -- no action needed from you.`;
    const spec = buildClosePrSpec({ repoFullName: input.repoFullName, number: input.selfPrNumber, comment });
    const closeResult = await deps.executeLocalWrite(spec);
    return {
        checked: true,
        isWinner: false,
        winnerNumber: adjudication.winnerNumber,
        competingCount: competing.length,
        closeResult,
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xhaW0tY29uZmxpY3QtcmVzb2x2ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJjbGFpbS1jb25mbGljdC1yZXNvbHZlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwwR0FBMEc7QUFDMUcsOEdBQThHO0FBQzlHLDZHQUE2RztBQUM3Ryw2R0FBNkc7QUFDN0csMkdBQTJHO0FBQzNHLDRHQUE0RztBQUM1Ryx5R0FBeUc7QUFDekcsOEdBQThHO0FBQzlHLDhHQUE4RztBQUM5RywrR0FBK0c7QUFDL0csaUNBQWlDO0FBQ2pDLEVBQUU7QUFDRixzR0FBc0c7QUFDdEcsK0dBQStHO0FBQy9HLDJHQUEyRztBQUMzRyw2R0FBNkc7QUFDN0csNEdBQTRHO0FBQzVHLDJHQUEyRztBQUMzRyx1REFBdUQ7QUFDdkQsRUFBRTtBQUNGLHlHQUF5RztBQUN6Ryw2R0FBNkc7QUFDN0csMEdBQTBHO0FBQzFHLHlHQUF5RztBQUN6Ryx5R0FBeUc7QUFDekcsNEZBQTRGO0FBRTVGLE9BQU8sRUFBRSxtQkFBbUIsRUFBRSxNQUFNLHlCQUF5QixDQUFDO0FBQzlELE9BQU8sRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBQ3BELE9BQU8sRUFBRSxxQkFBcUIsRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBS3hELDBHQUEwRztBQUMxRywwR0FBMEc7QUFDMUcsTUFBTSw2QkFBNkIsR0FBRyxDQUFDLENBQUM7QUFDeEMsTUFBTSxvQkFBb0IsR0FBRyxDQUFDLE9BQWUsRUFBaUIsRUFBRSxDQUFDLElBQUksT0FBTyxDQUFDLENBQUMsT0FBTyxFQUFFLEVBQUUsQ0FBQyxVQUFVLENBQUMsT0FBTyxFQUFFLE9BQU8sQ0FBQyxDQUFDLENBQUM7QUFFeEg7Ozs7Ozs7Ozs7Ozs7O0dBY0c7QUFDSCxNQUFNLFVBQVUsdUJBQXVCLENBQ3JDLFFBQThDLEVBQzlDLFlBQW9CLEVBQ3BCLFVBQWtCO0lBRWxCLE1BQU0sYUFBYSxHQUFHLFVBQVUsQ0FBQyxJQUFJ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