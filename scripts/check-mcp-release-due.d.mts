import type { McpReleaseReport } from "./mcp-release-core.d.mts";

export type GitHubIssueCandidate = {
  pull_request?: unknown;
  title?: unknown;
  body?: unknown;
  user?: {
    login?: unknown;
  } | null;
};

export function isReleaseWatchIssue(issue: GitHubIssueCandidate): boolean;
export function closeResolvedIssueIfPresent(report: McpReleaseReport): Promise<void>;
