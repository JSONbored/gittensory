import { rankOpportunities, type OpportunityRankInput } from "./opportunity-ranker.js";

/**
 * Return the highest-scoring ranked candidate, or `null` when the list is empty.
 * Pure — delegates to {@link rankOpportunities} for scoring and tie-breaking.
 */
export function bestRankedOpportunity<T>(
  candidates: Array<T & OpportunityRankInput>,
): (Omit<T, "rankScore"> & OpportunityRankInput & { rankScore: number }) | null {
  const ranked = rankOpportunities(candidates);
  return ranked[0] ?? null;
}
