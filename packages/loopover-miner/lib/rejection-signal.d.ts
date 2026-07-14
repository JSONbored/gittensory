import type { SelfReviewContextFetch } from "./self-review-context.js";

type OwnRejectionHistorySubmission = { pullRequestNumber?: number | null };

type ListOwnSubmissions = (filter: { repoFullName?: string }) => OwnRejectionHistorySubmission[];

export interface OwnRejectionHistoryOptions {
  listSubmissions?: ListOwnSubmissions;
  fetchImpl?: SelfReviewContextFetch;
  githubToken?: string;
  githubApiBaseUrl?: string;
  maxRejectionHistoryChecks?: number;
}

export interface RejectionSignaledOptions extends OwnRejectionHistoryOptions {
  rawContentBaseUrl?: string;
}

export function resolveRejectionSignaled(
  repoFullName: string,
  options?: RejectionSignaledOptions,
): Promise<boolean>;

export function resolveOwnRejectionHistory(
  repoFullName: string,
  options?: OwnRejectionHistoryOptions,
): Promise<boolean>;
