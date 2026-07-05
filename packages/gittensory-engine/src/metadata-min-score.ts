import {
  rankMetadataOpportunities,
  type MetadataCandidateIssue,
  type MetadataRankContext,
} from "./opportunity-metadata.js";
import type { OpportunityRankInput } from "./opportunity-ranker.js";

/**
 * Rank metadata candidates and keep only those whose rank score is at or above `minScore`.
 * Non-finite thresholds return an empty list. Pure — delegates to {@link rankMetadataOpportunities}.
 */
export function rankMetadataOpportunitiesAtOrAboveScore<T extends MetadataCandidateIssue>(
  candidates: readonly T[],
  context: MetadataRankContext,
  minScore: number,
): Array<T & OpportunityRankInput & { rankScore: number }> {
  if (!Number.isFinite(minScore)) return [];
  if (candidates.length === 0) return [];
  const threshold = Math.min(1, Math.max(0, minScore));
  return rankMetadataOpportunities(candidates, context).filter((entry) => entry.rankScore >= threshold);
}
