/** A soft-claim record, from either the local claim ledger or an observed competing open PR. */
export type SoftClaimRecord = {
  /** Identifier for this claim — the PR number once opened. A not-yet-published soft-claim may omit this; it then
   *  defaults to a tie-losing sentinel so an equal-timestamp tie never favors it over a real open PR. */
  number?: number | null | undefined;
  /** The local/observed claim time (claim-ledger's `claimedAt`), mapped to the engine election's
   *  `linkedIssueClaimedAt`. A missing/invalid value fails closed (loses to any dated sibling). */
  claimedAt?: string | null | undefined;
};

/** The outcome of adjudicating one miner's soft-claim against the competing claims. */
export type SoftClaimAdjudication = {
  /** True iff this miner's claim is the elected cluster winner — safe to proceed. */
  wins: boolean;
  /** Display-only winning claim number, or `null` when the ordering is too sparse/ambiguous to name one. */
  winnerNumber: number | null;
  /** Whether any competing claim was supplied. */
  contested: boolean;
};

/**
 * Adjudicate this miner's soft-claim on an issue against the publicly-observable competing claims (typically the
 * open PRs that link the same issue), reusing the maintainer gate's `isDuplicateClusterWinnerByClaim` election so
 * both agree on exactly one winner by construction.
 */
export function adjudicateSoftClaim(
  ownClaim: SoftClaimRecord,
  competingClaims?: readonly SoftClaimRecord[] | undefined,
): SoftClaimAdjudication;
