import { rankMetadataOpportunitiesAtOrAboveScore } from "./metadata-min-score.js";
import type { MetadataCandidateIssue, MetadataRankContext } from "./opportunity-metadata.js";
import type { OpportunityRankInput } from "./opportunity-ranker.js";

/**
 * Return the highest-scoring metadata candidate at or above `minScore`, or `null` when none qualify.
 * Non-finite thresholds return `null`. Pure — delegates to {@link rankMetadataOpportunitiesAtOrAboveScore}.
 */
export function bestMetadataOpportunityAtOrAboveScore<T extends MetadataCandidateIssue>(
  candidates: readonly T[],
  context: MetadataRankContext,
  minScore: number,
): (T & OpportunityRankInput & { rankScore: number }) | null {
  const survivors = rankMetadataOpportunitiesAtOrAboveScore(candidates, context, minScore);
  return survivors[0] ?? null;
}
