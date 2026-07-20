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
import type { LiveIssueSnapshot } from "./submission-freshness-check.js";
import type { ObservedClaim } from "./claim-adjudication.js";
import type { LocalWriteActionSpec } from "@loopover/engine";

// Bounded retry for the post-submission live-state check (#6058): a few attempts give a competing PR that
// hasn't propagated through GitHub's search/GraphQL index yet time to surface, without an unbounded loop.
const DEFAULT_SNAPSHOT_MAX_ATTEMPTS = 3;
const defaultSnapshotSleep = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

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
export function assembleCompetingClaims(
  snapshot: LiveIssueSnapshot | null | undefined,
  selfPrNumber: number,
  minerLogin: string,
): ObservedClaim[] {
  const minerLoginKey = minerLogin.trim().toLowerCase();
  const referencingPrs = Array.isArray(snapshot?.referencingPrs) ? snapshot.referencingPrs : [];
  return referencingPrs
    .filter((pr) => pr.state === "open" && pr.number !== selfPrNumber)
    .filter((pr) => typeof pr.authorLogin !== "string" || pr.authorLogin.trim().toLowerCase() !== minerLoginKey)
    .map((pr) => ({ number: pr.number, claimedAt: pr.createdAt ?? null }));
}

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

export type ClaimConflictResult =
  | { checked: false; reason: "live_state_unavailable" }
  | { checked: true; isWinner: true; winnerNumber: number | null; competingCount: number }
  | { checked: true; isWinner: false; winnerNumber: number | null; competingCount: number; closeResult: unknown };

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
export async function resolveClaimConflict(
  input: ClaimConflictInput,
  deps: ClaimConflictDeps,
  options: ClaimConflictRetryOptions = {},
): Promise<ClaimConflictResult> {
  const maxAttempts =
    Number.isFinite(options.maxAttempts) && (options.maxAttempts as number) >= 1
      ? Math.floor(options.maxAttempts as number)
      : DEFAULT_SNAPSHOT_MAX_ATTEMPTS;
  const sleepFn = typeof options.sleepFn === "function" ? options.sleepFn : defaultSnapshotSleep;
  const backoffMs = typeof options.backoffMs === "function" ? options.backoffMs : defaultRetryBackoffMs;

  let snapshot: LiveIssueSnapshot | null = null;
  let competing: ObservedClaim[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let current: LiveIssueSnapshot | null;
    try {
      current = await deps.fetchLiveIssueSnapshot(input.repoFullName, input.issueNumber);
    } catch {
      current = null;
    }
    if (current && typeof current === "object") {
      snapshot = current;
      competing = assembleCompetingClaims(current, input.selfPrNumber, input.minerLogin);
      // A competing claim observed = GitHub's index has propagated it; stop retrying and act on it now.
      if (competing.length > 0) break;
    }
    // Back off before the next attempt (index-propagation lag / a transient fetch failure); never after the last.
    if (attempt < maxAttempts) await sleepFn(backoffMs(attempt));
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
