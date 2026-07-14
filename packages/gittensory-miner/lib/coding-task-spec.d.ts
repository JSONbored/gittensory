import type { AcceptanceCriteria, FeasibilityGateResult, FeasibilityVerdict, IssueRecord, PullRequestRecord } from "@loopover/engine";
import type { RepoStackResult } from "./stack-detection.js";

export type CodingTaskIssue = { number: number; title: string; body?: string | null | undefined; labels?: string[] | undefined };

export type CodingTaskClaimLedger = {
  listClaims(filter: { repoFullName: string; status: string }): Array<{ issueNumber: number }>;
};

export type CodingTaskContext = { issues: IssueRecord[]; pullRequests: PullRequestRecord[] };

export function buildCodingTaskFeasibility(
  repoFullName: string,
  issue: CodingTaskIssue,
  context: CodingTaskContext,
  claimLedger: CodingTaskClaimLedger,
): FeasibilityGateResult;

export function buildCodingTaskAcceptanceCriteria(issue: CodingTaskIssue, feasibility: FeasibilityGateResult): AcceptanceCriteria;

export function writeAcceptanceCriteriaFile(workingDirectory: string, acceptanceCriteria: AcceptanceCriteria): { written: boolean; path: string | null };

export type CodingTaskSpecInput = {
  repoFullName: string;
  issue: CodingTaskIssue;
  context: CodingTaskContext;
  claimLedger: CodingTaskClaimLedger;
  workingDirectory: string;
  /** Injectable stack detector (#4786); omitted falls back to stack-detection.js's real `detectRepoStack`. */
  detectRepoStack?: (repoPath: string) => RepoStackResult;
};

export type CodingTaskSpecResult =
  | { ready: false; verdict: FeasibilityVerdict; feasibility: FeasibilityGateResult }
  | {
      ready: true;
      verdict: FeasibilityVerdict;
      feasibility: FeasibilityGateResult;
      acceptanceCriteriaPath: string;
      instructions: string;
      title: string;
      body: string | undefined;
      labels: string[] | undefined;
      linkedIssues: number[];
    };

export function buildCodingTaskSpec(input: CodingTaskSpecInput): CodingTaskSpecResult;
