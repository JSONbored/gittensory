import { rankOpportunities, type OpportunityRankInput } from "./opportunity-ranker.js";

/**
 * Rank candidates and keep only those whose {@link rankOpportunityScore} is at or above `minScore`.
 * Non-finite thresholds return an empty list. Pure — delegates ordering to {@link rankOpportunities}.
 */
export function rankOpportunitiesAtOrAboveScore<T>(
  candidates: Array<T & OpportunityRankInput>,
  minScore: number,
): Array<Omit<T, "rankScore"> & OpportunityRankInput & { rankScore: number }> {
  if (!Number.isFinite(minScore)) return [];
  if (candidates.length === 0) return [];
  const threshold = Math.min(1, Math.max(0, minScore));
  return rankOpportunities(candidates).filter((entry) => entry.rankScore >= threshold);
}
