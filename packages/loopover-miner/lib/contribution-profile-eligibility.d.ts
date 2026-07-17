import type { ContributionProfile } from "./contribution-profile.js";
import type { RawCandidateIssue } from "./opportunity-fanout.js";

export type CandidateEligibilityResult = {
  excluded: boolean;
  reasons: string[];
};

export type ExcludedCandidate = {
  issue: RawCandidateIssue;
  reasons: string[];
};

export type FilterCandidatesResult = {
  eligible: RawCandidateIssue[];
  excluded: ExcludedCandidate[];
};

export function evaluateCandidateEligibility(
  issue: RawCandidateIssue,
  profile: ContributionProfile | null | undefined,
  options?: {
    labelDescriptionsByName?: Map<string, string | null>;
    excludeAssignedLogins?: string[];
  },
): CandidateEligibilityResult;

export function filterEligibleCandidates(
  issues: RawCandidateIssue[],
  profilesByRepo: Map<string, ContributionProfile>,
  options?: {
    labelDescriptionsByRepo?: Map<string, Map<string, string | null>>;
  },
): FilterCandidatesResult;

export function profileNeedsLabelDescriptions(profile: ContributionProfile | null | undefined): boolean;

export function fetchRepoLabelDescriptions(
  repoFullName: string,
  options?: {
    fetchImpl?: typeof fetch;
    githubToken?: string;
    apiBaseUrl?: string;
  },
): Promise<Map<string, string | null>>;
