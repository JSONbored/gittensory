import type { BountyRecord, IssueRecord, PullRequestRecord, RepositoryRecord } from "../types";
import {
  buildPreflightResult,
  buildRoleContext,
  type PreflightInput,
  type PreflightResult,
  type RoleContext,
} from "./engine";

export type ReviewRiskRecommendation =
  | "likely_duplicate"
  | "maintainer_lane"
  | "needs_author"
  | "review"
  | "watch";

export type ReviewRiskExplanation = {
  preflight: PreflightResult;
  roleContext: RoleContext | null;
  recommendation: ReviewRiskRecommendation;
  summary: string;
};

/**
 * Review-risk explanation for a planned PR — shared by `loopover_explain_review_risk`
 * and `POST /v1/preflight/review-risk`. Uses the same `buildPreflightResult` core as
 * PR preflight (without issueQuality) plus optional per-contributor role context.
 */
export function buildReviewRiskExplanation(args: {
  input: PreflightInput;
  repo: RepositoryRecord | null;
  issues: IssueRecord[];
  pullRequests: PullRequestRecord[];
  bounties?: BountyRecord[];
}): ReviewRiskExplanation {
  const { input, repo, issues, pullRequests, bounties = [] } = args;
  const preflight = buildPreflightResult(input, repo, issues, pullRequests, bounties);
  const roleContext = input.contributorLogin
    ? buildRoleContext({ login: input.contributorLogin, repo, repoFullName: input.repoFullName, pullRequests, issues })
    : null;
  const recommendation: ReviewRiskRecommendation = preflight.collisions.some((cluster) => cluster.risk === "high")
    ? "likely_duplicate"
    : roleContext?.maintainerLane
      ? "maintainer_lane"
      : preflight.status === "needs_work"
        ? "needs_author"
        : preflight.status === "ready"
          ? "review"
          : "watch";
  return {
    preflight,
    roleContext,
    recommendation,
    summary: `LoopOver review-risk explanation for ${input.repoFullName}.`,
  };
}
