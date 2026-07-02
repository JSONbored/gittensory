// Opportunity ranker (#2302). The core Phase-1 miner-discovery ranker: it composes five already-normalized,
// deterministic signals into a single ordinal score used to sort a cross-repo candidate-issue list, so a later
// `gittensory_find_opportunities` tool has something deterministic to sort by.
//
// This module is PURE — no IO, no Date, no random — so identical inputs always produce identical order, matching
// the house convention in src/signals/duplicate-winner.ts. Every input is clamped to [0, 1] before it is used, so
// a malformed upstream signal degrades the score toward 0 instead of inverting or blowing up the product.

/** The five 0-1 normalized signals for one candidate opportunity. */
export type OpportunityRankInput = {
  /** Expected reward if the work is won (score / label-multiplier potential). */
  potential: number;
  /** How achievable the issue is for the miner. */
  feasibility: number;
  /** Fit with the miner's preferred lanes. */
  laneFit: number;
  /** How recently actionable the opportunity is (decays as it ages). */
  freshness: number;
  /** Risk the work is already claimed / contested; higher means more likely a wasted attempt. */
  dupRisk: number;
};

/** Clamp a positive factor to [0, 1]; a non-finite value (NaN/±Infinity from a broken upstream) degrades to 0. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Normalize the contention/risk signal, failing CLOSED: any value that is not a real number in [0, 1] — non-finite
 * (`NaN`/`±Infinity`), negative, or above 1 — is treated as MAXIMUM risk (1), not passed through and not clamped to
 * a lower risk. A malformed contention signal must collapse the opportunity score, never masquerade as a safe,
 * uncontested one; a below-range value is as malformed as `NaN`, so both directions fail closed (mirroring the
 * fail-closed convention in `src/signals/duplicate-winner.ts`, where sparse rows fail closed). This keeps the
 * "malformed input degrades the score toward 0" contract true in BOTH directions: a broken positive factor → 0, a
 * broken `dupRisk` → 1 → `(1 - 1) = 0`.
 */
function clampRisk(value: number): number {
  if (!(value >= 0 && value <= 1)) return 1;
  return value;
}

/**
 * The ordinal opportunity score: `potential * feasibility * laneFit * freshness * (1 - dupRisk)`, with every field
 * clamped to [0, 1] first. Because it is a product, ANY single factor at 0 — or a `dupRisk` of exactly 1 — collapses
 * the whole score to 0: a candidate that fails any one dimension is not an opportunity. Malformed input never passes
 * through raw and always degrades the score toward 0: the four positive factors clamp a non-finite value to 0, while
 * `dupRisk` fails closed to 1 (max risk). So a bad signal can neither invert the sign nor overflow the product. Pure.
 *
 * Signal-source map for the composing caller (a later issue): `feasibility` ← the per-repo report in
 * `src/services/issue-quality.ts`; `laneFit` ← `MinerGoalSpec.preferredLanes` (the goal-model issue); `freshness`
 * ← `src/signals/reward-risk.ts`'s `freshnessFactor`; `dupRisk` ← `src/signals/reward-risk.ts`'s
 * `competitionFactor` combined with `src/signals/duplicate-winner.ts`'s claim adjudication.
 */
export function rankOpportunityScore(input: OpportunityRankInput): number {
  return (
    clamp01(input.potential) *
    clamp01(input.feasibility) *
    clamp01(input.laneFit) *
    clamp01(input.freshness) *
    (1 - clampRisk(input.dupRisk))
  );
}

/**
 * Rank a candidate list by descending {@link rankOpportunityScore}, annotating each candidate with its `rankScore`.
 * Equal scores keep their input order: the tie-break is made EXPLICIT via a carried index (`rankScore` desc, then
 * `index` asc) rather than relying on `Array.prototype.sort` stability, so the contract holds on any engine and is
 * enforced by this function. Mirrors the tie-break intent of `isDuplicateClusterWinnerByClaim` in
 * src/signals/duplicate-winner.ts, where an earlier entry wins a tie. Pure — returns a new array; the input array
 * and its elements are not mutated.
 */
export function rankOpportunities<T>(
  candidates: Array<T & OpportunityRankInput>,
): Array<T & OpportunityRankInput & { rankScore: number }> {
  return candidates
    .map((candidate, index) => ({ candidate, rankScore: rankOpportunityScore(candidate), index }))
    .sort((a, b) => b.rankScore - a.rankScore || a.index - b.index)
    .map(({ candidate, rankScore }) => ({ ...candidate, rankScore }));
}
