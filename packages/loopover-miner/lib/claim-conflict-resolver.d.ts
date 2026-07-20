import type { LiveIssueSnapshot } from "./submission-freshness-check.js";
import type { ObservedClaim } from "./claim-adjudication.js";
import type { LocalWriteActionSpec } from "@loopover/engine";
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
export declare function assembleCompetingClaims(snapshot: LiveIssueSnapshot | null | undefined, selfPrNumber: number, minerLogin: string): ObservedClaim[];
export type ClaimConflictInput = {
    repoFullName: string;
    issueNumber: number;
    selfPrNumber: number;
    selfClaimedAt: string | null;
    minerLogin: string;
};
export type ClaimConflictDeps = {
    fetchLiveIssueSnapshot: (repoFullName: string, issueNumber: number) => Promise<LiveIssueSnapshot | null>;
    executeLocalWrite: (spec: LocalWriteActionSpec) => Promise<unknown>;
};
export type ClaimConflictResult = {
    checked: false;
    reason: "live_state_unavailable";
} | {
    checked: true;
    isWinner: true;
    winnerNumber: number | null;
    competingCount: number;
} | {
    checked: true;
    isWinner: false;
    winnerNumber: number | null;
    competingCount: number;
    closeResult: unknown;
};
export type ClaimConflictRetryOptions = {
    maxAttempts?: number;
    sleepFn?: (ms: number) => Promise<unknown>;
    backoffMs?: (attempt: number) => number;
};
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
export declare function resolveClaimConflict(input: ClaimConflictInput, deps: ClaimConflictDeps, options?: ClaimConflictRetryOptions): Promise<ClaimConflictResult>;
