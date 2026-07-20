import type { DuplicateClaimMember } from "@loopover/engine";
/** An observed claim on an issue: a PR/claimant number plus when it claimed the linked issue (if known). */
export type ObservedClaim = {
    number: number;
    claimedAt?: string | null | undefined;
};
/** The engine `DuplicateClaimMember` shape this module bridges an {@link ObservedClaim} to. */
export type ClaimMember = DuplicateClaimMember;
/** The adjudication result: the go/no-go `isWinner`, plus a DISPLAY-only `winnerNumber` (null when not determinable). */
export type ClaimAdjudication = {
    isWinner: boolean;
    winnerNumber: number | null;
};
/**
 * Map an observed claim record to the engine's `DuplicateClaimMember`. The field names deliberately DIFFER — the
 * local ledger / observed data expose `claimedAt`, the engine election reads `linkedIssueClaimedAt` — so the bridge
 * is explicit (they are not interchangeable by accident of naming). `createdAt` is intentionally omitted: the
 * election ignores it (an older PR can claim a linked issue later by editing its body). Pure.
 */
export declare function toClaimMember(claim: ObservedClaim): ClaimMember;
/**
 * Adjudicate whether THIS miner's soft-claim wins a contested issue. `self` is this miner's claim and `competing`
 * is the publicly-observable set of OTHER open PRs linking the same issue; each entry is `{ number, claimedAt }`.
 * Returns the go/no-go `isWinner` (driven ONLY by `isDuplicateClusterWinnerByClaim`) plus a DISPLAY-only
 * `winnerNumber` (from `resolveDuplicateClusterWinnerNumber`, for surfacing "you lost this claim to PR #N" to the
 * operator — never for the decision). Pure — no IO. Fail-closed: a missing/sparse claim time loses; the winner is
 * `null` when the ordering is too sparse to be sure (it never guesses). An empty `competing` list ⇒ trivial winner.
 */
export declare function adjudicateSoftClaim(self: ObservedClaim, competing?: readonly ObservedClaim[]): ClaimAdjudication;
