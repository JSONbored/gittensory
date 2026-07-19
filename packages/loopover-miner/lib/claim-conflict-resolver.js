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
 * `options` is the bounded retry for the live-state snapshot fetch (#6058): up to `maxAttempts` (default 3)
 * attempts with `backoffMs(attempt)` backoff between them, returning as soon as a competing claim is observed.
 * Pure over the injected `sleepFn`/`backoffMs` -- no real timers in tests.
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2xhaW0tY29uZmxpY3QtcmVzb2x2ZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJjbGFpbS1jb25mbGljdC1yZXNvbHZlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwwR0FBMEc7QUFDMUcsOEdBQThHO0FBQzlHLDZHQUE2RztBQUM3Ryw2R0FBNkc7QUFDN0csMkdBQTJHO0FBQzNHLDRHQUE0RztBQUM1Ryx5R0FBeUc7QUFDekcsOEdBQThHO0FBQzlHLDhHQUE4RztBQUM5RywrR0FBK0c7QUFDL0csaUNBQWlDO0FBQ2pDLEVBQUU7QUFDRixzR0FBc0c7QUFDdEcsK0dBQStHO0FBQy9HLDJHQUEyRztBQUMzRyw2R0FBNkc7QUFDN0csNEdBQTRHO0FBQzVHLDJHQUEyRztBQUMzRyx1REFBdUQ7QUFDdkQsRUFBRTtBQUNGLHlHQUF5RztBQUN6Ryw2R0FBNkc7QUFDN0csMEdBQTBHO0FBQzFHLHlHQUF5RztBQUN6Ryx5R0FBeUc7QUFDekcsNEZBQTRGO0FBRTVGLE9BQU8sRUFBRSxtQkFBbUIsRUFBRSxNQUFNLHlCQUF5QixDQUFDO0FBRTlELE9BQU8sRUFBRSxnQkFBZ0IsRUFBRSxNQUFNLGtCQUFrQixDQUFDO0FBRXBELE9BQU8sRUFBRSxxQkFBcUIsRUFBRSxNQUFNLGlCQUFpQixDQUFDO0FBR3hELDBHQUEwRztBQUMxRywwR0FBMEc7QUFDMUcsTUFBTSw2QkFBNkIsR0FBRyxDQUFDLENBQUM7QUFDeEMsTUFBTSxvQkFBb0IsR0FBRyxDQUFDLE9BQWUsRUFBb0IsRUFBRSxDQUNqRSxJQUFJLE9BQU8sQ0FBQyxDQUFDLE9BQU8sRUFBRSxFQUFFLENBQUMsVUFBVSxDQUFDLE9BQU8sRUFBRSxPQUFPLENBQUMsQ0FBQyxDQUFDO0FBRXpEOzs7Ozs7Ozs7R0FTRztBQUNILE1BQU0sVUFBVSx1QkFBdUIsQ0FDckMsUUFBOEMsRUFDOUMsWUFBb0IsRUFDcEIsVUFBa0I7SUFFbEIsTUFBTSxhQUFhLEdBQUcsVUFBVSxDQUFDLElBQUksRUFBRSxDQUFDLFdBQVcsRUFBRSxDQUFDO0lBQ3RELE1BQU0sY0FBYyxHQUFHLEtBQUssQ0FBQyxPQUFPLENBQUMsUUFBUSxFQUFFLGNBQWMsQ0FBQyxDQUFDLENBQUMsQ0FBQyxRQUFRLENBQUMsY0FBYyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUM7SUFDOUYsT0FBTyxjQUFjO1NBQ2xCLE1BQU0sQ0FBQyxDQUFDLEVBQUUsRUFBRSxFQUFFLENBQUMsRUFBRSxDQUFDLEtBQUssS0FBSyxNQUFNLElBQUksRUFBRSxDQUFDLE1BQU0sS0FBSyxZQUFZLENBQUM7U0FDakUsTUFBTSxDQUFDLENBQUMsRUFBRSxFQUFFLEVBQUUsQ0FBQyxPQUFPLEVBQUUsQ0FBQyxXQUFXLEtBQUssUUFBUSxJQUFJLEVBQUUsQ0FBQyxXQUFXLENBQUMsSUFBSSxFQUFFLENBQUMsV0FBVyxFQUFFLEtBQUssYUFBYSxDQUFDO1NBQzNHLEdBQUcsQ0FBQyxDQUFDLEVBQUUsRUFBRSxFQUFFLENBQUMsQ0FBQyxFQUFFLE1BQU0sRUFBRSxFQUFFLENBQUMsTUFBTSxFQUFFLFNBQVMsRUFBRSxFQUFFLENBQUMsU0FBUyxJQUFJLElBQUksRUFBRSxDQUFDLENBQUMsQ0FBQztBQUMzRSxDQUFDO0FBMEJEOzs7Ozs7O0dBT0c7QUFDSCxNQUFNLENBQUMsS0FBSyxVQUFVLG9CQUFvQixDQUN4QyxLQUF5QixFQUN6QixJQUF1QixFQUN2QixVQUFxQyxFQUFFO0lBRXZDLE1BQU0sV0FBVyxHQUNmLE1BQU0sQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLFdBQVcsQ0FBQyxJQUFLLE9BQU8sQ0FBQyxXQUFzQixJQUFJLENBQUM7UUFDMUUsQ0FBQyxDQUFDLElBQUksQ0FBQyxLQUFLLENBQUMsT0FBTyxDQUFDLFdBQXFCLENBQUM7UUFDM0MsQ0FBQyxDQUFDLDZCQUE2QixDQUFDO0lBQ3BDLE1BQU0sT0FBTyxHQUFHLE9BQU8sT0FBTyxDQUFDLE9BQU8sS0FBSyxVQUFVLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUMsQ0FBQyxDQUFDLG9CQUFvQixDQUFDO0lBQy9GLE1BQU0sU0FBUyxHQUFHLE9BQU8sT0FBTyxDQUFDLFNBQVMsS0FBSyxVQUFVLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxTQUFTLENBQUMsQ0FBQyxDQUFDLHFCQUFxQixDQUFDO0lBRXRHLElBQUksUUFBUSxHQUE2QixJQUFJLENBQUM7SUFDOUMsSUFBSSxTQUFTLEdBQW9CLEVBQUUsQ0FBQztJQUNwQyxLQUFLLElBQUksT0FBTyxHQUFHLENBQUMsRUFBRSxPQUFPLElBQUksV0FBVyxFQUFFLE9BQU8sSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUMzRCxJQUFJLE9BQWlDLENBQUM7UUFDdEMsSUFBSSxDQUFDO1lBQ0gsT0FBTyxHQUFHLE1BQU0sSUFBSSxDQUFDLHNCQUFzQixDQUFDLEtBQUssQ0FBQyxZQUFZLEVBQUUsS0FBSyxDQUFDLFdBQVcsQ0FBQyxDQUFDO1FBQ3JGLENBQUM7UUFBQyxNQUFNLENBQUM7WUFDUCxPQUFPLEdBQUcsSUFBSSxDQUFDO1FBQ2pCLENBQUM7UUFDRCxJQUFJLE9BQU8sSUFBSSxPQUFPLE9BQU8sS0FBSyxRQUFRLEVBQUUsQ0FBQztZQUMzQyxRQUFRLEdBQUcsT0FBTyxDQUFDO1lBQ25CLFNBQVMsR0FBRyx1QkFBdUIsQ0FBQyxPQUFPLEVBQUUsS0FBSyxDQUFDLFlBQVksRUFBRSxLQUFLLENBQUMsVUFBVSxDQUFDLENBQUM7WUFDbkYsa0dBQWtHO1lBQ2xHLElBQUksU0FBUyxDQUFDLE1BQU0sR0FBRyxDQUFDO2dCQUFFLE1BQU07UUFDbEMsQ0FBQztRQUNELDhHQUE4RztRQUM5RyxJQUFJLE9BQU8sR0FBRyxXQUFXO1lBQUUsTUFBTSxPQUFPLENBQUMsU0FBUyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUM7SUFDL0QsQ0FBQztJQUNELElBQUksQ0FBQyxRQUFRLEVBQUUsQ0FBQztRQUNkLE9BQU8sRUFBRSxPQUFPLEVBQUUsS0FBSyxFQUFFLE1BQU0sRUFBRSx3QkFBd0IsRUFBRSxDQUFDO0lBQzlELENBQUM7SUFFRCxNQUFNLFlBQVksR0FBRyxtQkFBbUIsQ0FBQyxFQUFFLE1BQU0sRUFBRSxLQUFLLENBQUMsWUFBWSxFQUFFLFNBQVMsRUFBRSxLQUFLLENBQUMsYUFBYSxFQUFFLEVBQUUsU0FBUyxDQUFDLENBQUM7SUFFcEgsSUFBSSxZQUFZLENBQUMsUUFBUSxFQUFFLENBQUM7UUFDMUIsT0FBTyxFQUFFLE9BQU8sRUFBRSxJQUFJLEVBQUUsUUFBUSxFQUFFLElBQUksRUFBRSxZQUFZLEVBQUUsWUFBWSxDQUFDLFlBQVksRUFBRSxjQUFjLEVBQUUsU0FBUyxDQUFDLE1BQU0sRUFBRSxDQUFDO0lBQ3RILENBQUM7SUFFRCxNQUFNLE9BQU8sR0FBRyxZQUFZLENBQUMsWUFBWTtRQUN2QyxDQUFDLENBQUMsa0NBQWtDLFlBQVksQ0FBQyxZQUFZLDhHQUE4RztRQUMzSyxDQUFDLENBQUMseUpBQXlKLENBQUM7SUFDOUosTUFBTSxJQUFJLEdBQUcsZ0JBQWdCLENBQUMsRUFBRSxZQUFZLEVBQUUsS0FBSyxDQUFDLFlBQVksRUFBRSxNQUFNLEVBQUUsS0FBSyxDQUFDLFlBQVksRUFBRSxPQUFPLEVBQUUsQ0FBQyxDQUFDO0lBQ3pHLE1BQU0sV0FBVyxHQUFHLE1BQU0sSUFBSSxDQUFDLGlCQUFpQixDQUFDLElBQUksQ0FBQyxDQUFDO0lBRXZELE9BQU87UUFDTCxPQUFPLEVBQUUsSUFBSTtRQUNiLFFBQVEsRUFBRSxLQUFLO1FBQ2YsWUFBWSxFQUFFLFlBQVksQ0FBQyxZQUFZO1FBQ3ZDLGNBQWMsRUFBRSxTQUFTLENBQUMsTUFBTTtRQUNoQyxXQUFXO0tBQ1osQ0FBQztBQUNKLENBQUMifQ==