import type { ContributionProfile } from "./contribution-profile.js";

export const ELIGIBILITY_EXCLUSION_REASONS: {
  readonly EXCLUSION_LABEL: "exclusion_label";
  readonly MISSING_ELIGIBILITY_LABEL: "missing_eligibility_label";
  readonly CONFLICTING_SIGNALS: "conflicting_signals";
  readonly EXCLUDED_ASSIGNEE: "excluded_assignee";
};

export type EligibilityExclusion<T> = {
  candidate: T;
  reason:
    | "exclusion_label"
    | "missing_eligibility_label"
    | "conflicting_signals"
    | "excluded_assignee";
};

export function filterCandidatesByProfiles<
  T extends { repoFullName: string; owner?: string; labels?: string[]; assignees?: string[] },
>(
  candidates: T[],
  profilesByRepo: Map<string, ContributionProfile>,
): { kept: T[]; excluded: EligibilityExclusion<T>[] };
