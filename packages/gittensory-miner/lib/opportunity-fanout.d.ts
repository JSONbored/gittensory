import type { PolicyDocCache } from "./policy-doc-cache.js";

export type FanoutTarget = {
  owner: string;
  repo: string;
};

/** Options common to every fan-out/search entry point. `policyDocCache`, when supplied, lets discovery revalidate
 * each repo's policy docs with a conditional GET instead of a full refetch (#4842). */
export type FanoutOptions = {
  apiBaseUrl?: string;
  concurrency?: number;
  perPage?: number;
  sleepFn?: (ms: number) => Promise<unknown>;
  policyDocCache?: PolicyDocCache | null;
};

export type RawCandidateIssue = {
  owner: string;
  repo: string;
  repoFullName: string;
  issueNumber: number;
  title: string;
  labels: string[];
  commentsCount: number;
  createdAt: string | null;
  updatedAt: string | null;
  htmlUrl: string | null;
  aiPolicyAllowed: true;
  aiPolicySource: "AI-USAGE.md" | "CONTRIBUTING.md" | "none";
};

export type CandidateIssueWarning = {
  repoFullName: string;
  stage: string;
  message: string;
};

export type CandidateIssueSummary = {
  issues: RawCandidateIssue[];
  rateLimitRemaining: number | null;
  rateLimitResetAt: string | null;
  warnings: CandidateIssueWarning[];
};

export function mapWithConcurrency<T, R>(
  items: T[],
  maxConcurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  resolveLimit: () => number,
  sleepFn?: (ms: number) => Promise<unknown>,
): Promise<R[]>;

export function fetchCandidateIssuesWithSummary(
  targets: FanoutTarget[],
  githubToken: string,
  options?: FanoutOptions,
): Promise<CandidateIssueSummary>;

export function fetchCandidateIssues(
  targets: FanoutTarget[],
  githubToken: string,
  options?: FanoutOptions,
): Promise<RawCandidateIssue[]>;

export function searchCandidateIssuesWithSummary(
  searchQuery: string,
  githubToken: string,
  options?: FanoutOptions,
): Promise<CandidateIssueSummary>;

export function searchCandidateIssues(
  searchQuery: string,
  githubToken: string,
  options?: FanoutOptions,
): Promise<RawCandidateIssue[]>;
