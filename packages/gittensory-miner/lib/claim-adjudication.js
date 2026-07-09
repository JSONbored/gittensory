// Miner-side soft-claim adjudication (#4291). Reuses the maintainer gate's own election rule,
// `isDuplicateClusterWinnerByClaim` from `@jsonbored/gittensory-engine`, so a miner deciding whether to pursue a
// contested issue reaches EXACTLY the same winner the maintainer gate would — by construction, not via a parallel
// reimplementation (see duplicate-winner.ts's "SECOND CONSUMER (#2278)" note earmarking this module for exactly
// this). The competing-claim signal is public: an issue with several open PRs linking it is itself the evidence of
// a contested claim, so the caller supplies those open PRs as the sibling set. Pure — no IO, no Date, no SQLite;
// the local claim ledger is never read here.

import { isDuplicateClusterWinnerByClaim, resolveDuplicateClusterWinnerNumber } from "@jsonbored/gittensory-engine";

// A soft-claim carries its LOCAL claim time under `claimedAt` (claim-ledger.js's `rowToClaim`), but the engine
// election orders members by `linkedIssueClaimedAt` — the field names do NOT line up by accident (#4291), so the
// mapping is explicit. A missing/non-string `claimedAt` becomes `null` and inherits the engine's fail-closed
// ordering (an undated claim loses to any dated sibling). A claim with no `number` yet (a soft-claim not yet
// published as a PR) defaults to `Number.MAX_SAFE_INTEGER`, which loses every equal-timestamp tie — so an
// unpublished local claim never outranks a real open PR by tie-break alone.
function toClaimMember(claim) {
  const rawNumber = claim == null ? undefined : claim.number;
  const number = Number.isFinite(rawNumber) ? Math.trunc(rawNumber) : Number.MAX_SAFE_INTEGER;
  const rawClaimedAt = claim == null ? undefined : claim.claimedAt;
  const claimedAt = typeof rawClaimedAt === "string" ? rawClaimedAt : null;
  return { number, linkedIssueClaimedAt: claimedAt };
}

/**
 * Adjudicate this miner's soft-claim on an issue against the publicly-observable competing claims (typically the
 * open PRs that link the same issue). Returns whether this miner is the elected winner (safe to proceed), the
 * winning claim number for display, and whether the claim is contested at all. The go/no-go decision is driven
 * only by the engine election; `winnerNumber` is display-only (mirroring `resolveDuplicateClusterWinnerNumber`).
 *
 * @param {{ number?: number | null, claimedAt?: string | null }} ownClaim
 * @param {ReadonlyArray<{ number?: number | null, claimedAt?: string | null }>} [competingClaims]
 * @returns {{ wins: boolean, winnerNumber: number | null, contested: boolean }}
 */
export function adjudicateSoftClaim(ownClaim, competingClaims) {
  const own = toClaimMember(ownClaim);
  const siblings = Array.isArray(competingClaims) ? competingClaims.map(toClaimMember) : [];
  return {
    wins: isDuplicateClusterWinnerByClaim(own, siblings),
    winnerNumber: resolveDuplicateClusterWinnerNumber(own, siblings),
    contested: siblings.length > 0,
  };
}
