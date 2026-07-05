import { rankOpportunitiesAtOrAboveScore } from "./ranked-opportunity-min-score.js";
import type { OpportunityRankInput } from "./opportunity-ranker.js";

/**
 * Rank candidates, drop entries below `minScore`, and return the top `limit` survivors.
 * Non-finite limits return an empty list. Pure — delegates to {@link rankOpportunitiesAtOrAboveScore}.
 */
export function pickTopRankedOpportunitiesAtOrAboveScore<T>(
  candidates: Array<T & OpportunityRankInput>,
  minScore: number,
  limit: number,
): Array<Omit<T, "rankScore"> & OpportunityRankInput & { rankScore: number }> {
  if (!Number.isFinite(limit)) return [];
  const safeLimit = Math.max(0, Math.trunc(limit));
  if (safeLimit === 0) return [];
  return rankOpportunitiesAtOrAboveScore(candidates, minScore).slice(0, safeLimit);
}
