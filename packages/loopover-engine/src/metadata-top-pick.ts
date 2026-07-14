import {
  rankMetadataOpportunities,
  type MetadataCandidateIssue,
  type MetadataRankContext,
} from "./opportunity-metadata.js";
import type { OpportunityRankInput } from "./opportunity-ranker.js";

/**
 * Rank metadata candidates and return the top `limit` entries. Non-finite or negative limits return an empty list.
 * Pure — delegates to {@link rankMetadataOpportunities} for target filtering, scoring, and tie-breaking.
 */
export function pickTopMetadataOpportunities<T extends MetadataCandidateIssue>(
  candidates: readonly T[],
  context: MetadataRankContext,
  limit: number,
): Array<T & OpportunityRankInput & { rankScore: number }> {
  if (!Number.isFinite(limit)) return [];
  const safeLimit = Math.max(0, Math.trunc(limit));
  if (safeLimit === 0 || candidates.length === 0) return [];
  return rankMetadataOpportunities(candidates, context).slice(0, safeLimit);
}
