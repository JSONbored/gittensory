import type { SelfReviewContextFetch } from "./self-review-context.js";

type OwnSubmissionsReader = (filter: {
  repoFullName?: string;
  limit?: number;
}) => ReadonlyArray<{ pullRequestNumber?: number | null }>;

export function resolveOwnRejectionHistory(
  repoFullName: string,
  options?: {
    githubToken?: string;
    apiBaseUrl?: string;
    maxSubmissions?: number;
    fetchImpl?: SelfReviewContextFetch;
    listRecentOwnSubmissions?: OwnSubmissionsReader;
  },
): Promise<boolean>;

export function resolveRejectionSignaled(
  repoFullName: string,
  options?: {
    rawContentBaseUrl?: string;
    githubToken?: string;
    apiBaseUrl?: string;
    maxSubmissions?: number;
    fetchImpl?: SelfReviewContextFetch;
    listRecentOwnSubmissions?: OwnSubmissionsReader;
  },
): Promise<boolean>;
