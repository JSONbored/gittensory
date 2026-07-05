import { rankMetadataOpportunitiesAtOrAboveScore } from "./metadata-min-score.js";
import type { MetadataCandidateIssue, MetadataRankContext } from "./opportunity-metadata.js";
import type { OpportunityRankInput } from "./opportunity-ranker.js";

/**
 * Rank metadata candidates, drop entries below `minScore`, and return the top `limit` survivors.
 * Non-finite limits return an empty list. Pure — delegates to {@link rankMetadataOpportunitiesAtOrAboveScore}.
 */
export function pickTopMetadataOpportunitiesAtOrAboveScore<T extends MetadataCandidateIssue>(
  candidates: readonly T[],
  context: MetadataRankContext,
  minScore: number,
  limit: number,
): Array<T & OpportunityRankInput & { rankScore: number }> {
  if (!Number.isFinite(limit)) return [];
  const safeLimit = Math.max(0, Math.trunc(limit));
  if (safeLimit === 0) return [];
  return rankMetadataOpportunitiesAtOrAboveScore(candidates, context, minScore).slice(0, safeLimit);
}
