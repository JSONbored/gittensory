import type { ScorePreviewInput, ScorePreviewResult } from "../scoring/preview";
import { buildScorePreview } from "../scoring/preview";
import type { IssueRecord, PullRequestRecord, RecentMergedPullRequestRecord, RepositoryRecord, ScoringModelSnapshotRecord } from "../types";
import { nowIso } from "../utils/json";
import {
  buildLaneAdvice,
  buildLocalDiffPreflightResult,
  buildRepoFitRecommendation,
  buildRoleContext,
  type ContributorOutcomeHistory,
  type ContributorProfile,
  type ContributorScoringProfile,
  type LocalDiffPreflightResult,
  type RoleContext,
} from "./engine";
import { buildRepoRewardRisk, type RepoRewardRisk, type RewardRiskAction } from "./reward-risk";

export type LocalBranchChangedFile = {
  path: string;
  previousPath?: string | undefined;
  additions?: number | undefined;
  deletions?: number | undefined;
  status?: "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown" | undefined;
  binary?: boolean | undefined;
};

export type LocalBranchValidation = {
  command: string;
  status: "passed" | "failed" | "not_run";
  summary?: string | undefined;
};

export type LocalBranchScorer = {
  mode: "metadata_only" | "external_command" | "gittensor_root";
  activeModel?: string | undefined;
  sourceTokenScore?: number | undefined;
  totalTokenScore?: number | undefined;
  sourceLines?: number | undefined;
  testTokenScore?: number | undefined;
  nonCodeTokenScore?: number | undefined;
  warnings?: string[] | undefined;
};

export type LocalBranchAnalysisInput = {
  login: string;
  repoFullName: string;
  baseRef?: string | undefined;
  headRef?: string | undefined;
  branchName?: string | undefined;
  commitMessages?: string[] | undefined;
  changedFiles?: LocalBranchChangedFile[] | undefined;
  validation?: LocalBranchValidation[] | undefined;
  linkedIssues?: number[] | undefined;
  labels?: string[] | undefined;
  title?: string | undefined;
  body?: string | undefined;
  localScorer?: LocalBranchScorer | undefined;
};

export type LocalBranchAnalysis = {
  login: string;
  repoFullName: string;
  generatedAt: string;
  baseRef?: string | undefined;
  headRef?: string | undefined;
  branchName?: string | undefined;
  lane: ReturnType<typeof buildLaneAdvice>;
  roleContext: RoleContext;
  preflight: LocalDiffPreflightResult;
  scorePreview: ScorePreviewResult;
  rewardRisk: RepoRewardRisk;
  scoreBlockers: string[];
  localFindings: Array<{
    code: string;
    severity: "info" | "warning" | "critical";
    title: string;
    detail: string;
    action?: string | undefined;
  }>;
  maintainerFit: {
    recommendation: ReturnType<typeof buildRepoFitRecommendation>["recommendation"];
    reviewBurden: LocalDiffPreflightResult["reviewBurden"];
    role: RoleContext["role"];
    maintainerLane: boolean;
    reasons: string[];
    risks: string[];
  };
  prPacket: {
    titleSuggestion: string;
    bodySections: Array<{ heading: string; lines: string[] }>;
    reviewerNotes: string[];
    validationSummary: {
      passed: number;
      failed: number;
      notRun: number;
      commands: LocalBranchValidation[];
    };
    publicSafeWarnings: string[];
  };
  nextActions: RewardRiskAction[];
  summary: string;
};

export function buildLocalBranchAnalysis(args: {
  input: LocalBranchAnalysisInput;
  repo: RepositoryRecord | null;
  issues: IssueRecord[];
  pullRequests: PullRequestRecord[];
  recentMergedPullRequests?: RecentMergedPullRequestRecord[] | undefined;
  profile: ContributorProfile;
  outcomeHistory: ContributorOutcomeHistory;
  scoringSnapshot: ScoringModelSnapshotRecord;
  scoringProfile?: ContributorScoringProfile | null | undefined;
}): LocalBranchAnalysis {
  const changedFiles = args.input.changedFiles ?? [];
  const changedPaths = changedFiles.map((file) => file.path);
  const testFiles = changedPaths.filter(isTestFile);
  const changedLineCount = changedFiles.reduce((sum, file) => sum + nonNegative(file.additions) + nonNegative(file.deletions), 0);
  const commitMessage = (args.input.commitMessages ?? []).join("\n\n").trim();
  const title = args.input.title?.trim() || titleFromBranch(args.input.branchName) || firstCommitTitle(args.input.commitMessages) || "Local branch preflight";
  const preflight = buildLocalDiffPreflightResult(
    {
      repoFullName: args.input.repoFullName,
      contributorLogin: args.input.login,
      title,
      body: args.input.body,
      labels: args.input.labels,
      changedFiles: changedPaths,
      linkedIssues: args.input.linkedIssues,
      tests: validationEvidence(args.input.validation),
      commitMessage,
      changedLineCount,
      testFiles,
    },
    args.repo,
    args.issues,
    args.pullRequests,
  );
  const roleContext = buildRoleContext({
    login: args.input.login,
    repo: args.repo,
    repoFullName: args.input.repoFullName,
    pullRequests: args.pullRequests,
    issues: args.issues,
    profile: args.profile,
  });
  const lane = buildLaneAdvice(args.repo, args.input.repoFullName);
  const repoOutcome = args.outcomeHistory.repoOutcomes.find((outcome) => sameRepo(outcome.repoFullName, args.input.repoFullName));
  const scoreInput = buildLocalScoreInput({
    input: args.input,
    changedFiles,
    changedLineCount,
    testFiles,
    linkedIssueCount: preflight.linkedIssues.length,
    roleContext,
    outcomeHistory: args.outcomeHistory,
    repoOutcome,
  });
  const scorePreview = buildScorePreview({
    input: scoreInput,
    repo: args.repo,
    snapshot: args.scoringSnapshot,
  });
  const rewardRisk = buildRepoRewardRisk({
    login: args.input.login,
    repo: args.repo,
    repoFullName: args.input.repoFullName,
    profile: args.profile,
    outcomeHistory: args.outcomeHistory,
    scoringSnapshot: args.scoringSnapshot,
    scoringProfile: args.scoringProfile,
    issues: args.issues,
    pullRequests: args.pullRequests,
    recentMergedPullRequests: args.recentMergedPullRequests ?? [],
  });
  const recommendation = buildRepoFitRecommendation({
    login: args.input.login,
    repo: args.repo,
    repoFullName: args.input.repoFullName,
    profile: args.profile,
    outcomeHistory: args.outcomeHistory,
    issues: args.issues,
    pullRequests: args.pullRequests,
  });
  const localFindings = buildLocalFindings(args.input, changedFiles, preflight, scorePreview);
  const validationSummary = summarizeValidation(args.input.validation ?? []);
  const prPacket = buildPublicSafePrPacket({
    title,
    preflight,
    changedFiles,
    validationSummary,
    roleContext,
    laneSummary: lane.summary,
    localFindings,
  });
  const scoreBlockers = [
    ...rewardRisk.scoreBlockers,
    ...scorePreview.warnings.filter((warning) => /not registered|no active|exceeds|credibility|token gate/i.test(warning)),
    ...preflight.findings.filter((finding) => finding.severity !== "info").map((finding) => finding.title),
  ];
  return {
    login: args.input.login,
    repoFullName: args.input.repoFullName,
    generatedAt: nowIso(),
    baseRef: args.input.baseRef,
    headRef: args.input.headRef,
    branchName: args.input.branchName,
    lane,
    roleContext,
    preflight,
    scorePreview,
    rewardRisk,
    scoreBlockers: [...new Set(scoreBlockers)],
    localFindings,
    maintainerFit: {
      recommendation: recommendation.recommendation,
      reviewBurden: preflight.reviewBurden,
      role: roleContext.role,
      maintainerLane: roleContext.maintainerLane,
      reasons: recommendation.reasons,
      risks: recommendation.risks,
    },
    prPacket,
    nextActions: rewardRisk.actions.slice(0, 6),
    summary: `${args.input.repoFullName}: local branch analysis is ${preflight.status}; ${rewardRisk.actions[0]?.actionKind ?? "no ranked action"} is the top private next action.`,
  };
}

function buildLocalScoreInput(args: {
  input: LocalBranchAnalysisInput;
  changedFiles: LocalBranchChangedFile[];
  changedLineCount: number;
  testFiles: string[];
  linkedIssueCount: number;
  roleContext: RoleContext;
  outcomeHistory: ContributorOutcomeHistory;
  repoOutcome?: ContributorOutcomeHistory["repoOutcomes"][number] | undefined;
}): ScorePreviewInput {
  const scorer = args.input.localScorer;
  const testLineCount = args.changedFiles.filter((file) => isTestFile(file.path)).reduce((sum, file) => sum + nonNegative(file.additions) + nonNegative(file.deletions), 0);
  const sourceLineCount = args.changedFiles
    .filter((file) => isCodeFile(file.path))
    .reduce((sum, file) => sum + nonNegative(file.additions) + nonNegative(file.deletions), 0);
  const nonCodeLineCount = Math.max(0, args.changedLineCount - sourceLineCount - testLineCount);
  return {
    repoFullName: args.input.repoFullName,
    targetType: "local_diff",
    targetKey: `${args.input.login}:${args.input.repoFullName}:${args.input.branchName ?? args.input.headRef ?? "local-branch"}`,
    contributorLogin: args.input.login,
    labels: args.input.labels ?? [],
    linkedIssueMode: args.roleContext.maintainerLane ? "maintainer" : args.linkedIssueCount > 0 ? "standard" : "none",
    sourceTokenScore: scorer?.sourceTokenScore ?? Math.max(0, sourceLineCount),
    totalTokenScore: scorer?.totalTokenScore ?? Math.max(0, args.changedLineCount),
    sourceLines: scorer?.sourceLines ?? Math.max(1, sourceLineCount || args.changedLineCount || 1),
    testTokenScore: scorer?.testTokenScore ?? testLineCount,
    nonCodeTokenScore: scorer?.nonCodeTokenScore ?? nonCodeLineCount,
    openPrCount: args.outcomeHistory.totals.openPullRequests,
    credibility: args.repoOutcome?.credibility ?? args.outcomeHistory.totals.credibility,
    metadataOnly: scorer?.mode !== "gittensor_root" && scorer?.mode !== "external_command",
  };
}

function buildLocalFindings(
  input: LocalBranchAnalysisInput,
  changedFiles: LocalBranchChangedFile[],
  preflight: LocalDiffPreflightResult,
  scorePreview: ScorePreviewResult,
): LocalBranchAnalysis["localFindings"] {
  const failedValidation = (input.validation ?? []).filter((entry) => entry.status === "failed");
  return [
    {
      code: "source_upload_disabled",
      severity: "info" as const,
      title: "Source upload disabled",
      detail: "Local MCP branch analysis used structured git metadata only; source contents were not uploaded.",
    },
    ...(input.repoFullName.toLowerCase() === "jsonbored/gittensory"
      ? [
          {
            code: "gittensory_not_registered",
            severity: "warning" as const,
            title: "Gittensory is not registered",
            detail: "Treat this project as product/maintainer work until it appears in the official registry snapshot.",
            action: "Do not treat this repo as a miner target yet.",
          },
        ]
      : []),
    ...(failedValidation.length > 0
      ? [
          {
            code: "failed_local_validation",
            severity: "warning" as const,
            title: "Local validation failed",
            detail: `${failedValidation.length} validation command(s) were reported as failed.`,
            action: "Fix validation before asking maintainers to review.",
          },
        ]
      : []),
    ...(changedFiles.some((file) => file.binary)
      ? [
          {
            code: "binary_diff_present",
            severity: "info" as const,
            title: "Binary changes detected",
            detail: "Binary file changes cannot be scored or reviewed from line metadata alone.",
          },
        ]
      : []),
    ...scorePreview.warnings.map((warning) => ({
      code: "score_preview_warning",
      severity: /not registered|no active|exceeds|credibility/i.test(warning) ? ("warning" as const) : ("info" as const),
      title: "Private preview warning",
      detail: warning,
    })),
    ...preflight.findings.map((finding) => ({
      code: `preflight_${finding.code}`,
      severity: finding.severity,
      title: finding.title,
      detail: finding.detail,
      action: finding.action,
    })),
  ];
}

function buildPublicSafePrPacket(args: {
  title: string;
  preflight: LocalDiffPreflightResult;
  changedFiles: LocalBranchChangedFile[];
  validationSummary: LocalBranchAnalysis["prPacket"]["validationSummary"];
  roleContext: RoleContext;
  laneSummary: string;
  localFindings: LocalBranchAnalysis["localFindings"];
}): LocalBranchAnalysis["prPacket"] {
  const topPaths = args.changedFiles.slice(0, 8).map((file) => file.path);
  const publicSafeWarnings = [
    ...(args.roleContext.maintainerLane ? ["This is maintainer-lane context; present it as repo stewardship work."] : []),
    ...args.preflight.findings
      .filter((finding) => finding.severity !== "info")
      .map((finding) => finding.publicText ?? finding.action ?? finding.title),
    ...args.localFindings
      .filter((finding) => finding.code !== "score_preview_warning" && finding.severity === "warning")
      .flatMap((finding) => (finding.action ? [finding.action] : [finding.title])),
  ].filter(isPublicSafeText);
  const validationLines =
    args.validationSummary.commands.length > 0
      ? args.validationSummary.commands.map((entry) => `- ${entry.status}: ${entry.command}${entry.summary ? ` (${entry.summary})` : ""}`)
      : ["- Not supplied yet."];
  return {
    titleSuggestion: args.title,
    bodySections: [
      {
        heading: "Summary",
        lines: ["Describe the user-visible problem or maintainer-facing improvement this branch addresses."],
      },
      {
        heading: "Linked Context",
        lines: args.preflight.linkedIssues.length > 0 ? args.preflight.linkedIssues.map((issue) => `- Closes #${issue}`) : ["- No linked issue detected; explain why this is a no-issue PR."],
      },
      {
        heading: "Changed Paths",
        lines: topPaths.length > 0 ? topPaths.map((path) => `- ${path}`) : ["- No changed paths were detected from local metadata."],
      },
      {
        heading: "Validation",
        lines: validationLines,
      },
    ],
    reviewerNotes: [
      `Lane context: ${args.laneSummary}`,
      `Review burden: ${args.preflight.reviewBurden}`,
      `Role context: ${args.roleContext.role}${args.roleContext.maintainerLane ? " (maintainer lane)" : ""}`,
    ],
    validationSummary: args.validationSummary,
    publicSafeWarnings: [...new Set(publicSafeWarnings)],
  };
}

function summarizeValidation(validation: LocalBranchValidation[]): LocalBranchAnalysis["prPacket"]["validationSummary"] {
  return {
    passed: validation.filter((entry) => entry.status === "passed").length,
    failed: validation.filter((entry) => entry.status === "failed").length,
    notRun: validation.filter((entry) => entry.status === "not_run").length,
    commands: validation,
  };
}

function validationEvidence(validation: LocalBranchValidation[] | undefined): string[] {
  return (validation ?? [])
    .filter((entry) => entry.status === "passed")
    .map((entry) => entry.command);
}

function titleFromBranch(branchName: string | undefined): string | undefined {
  const cleaned = branchName?.replace(/^[-/_.\w]+\/(?=[^/]+$)/, "").replace(/[-_]+/g, " ").trim();
  return cleaned || undefined;
}

function firstCommitTitle(messages: string[] | undefined): string | undefined {
  return messages?.find((message) => message.trim().length > 0)?.split("\n")[0]?.trim() || undefined;
}

function isPublicSafeText(text: string): boolean {
  return !/\b(reward|score|wallet|hotkey|coldkey|mnemonic|farming|payout|ranking|trust score)\b/i.test(text);
}

function isTestFile(file: string): boolean {
  return /(^|\/)(test|tests|spec|__tests__)\//i.test(file) || /\.(test|spec)\.(ts|tsx|js|jsx|py|rb|rs)$/i.test(file);
}

function isCodeFile(file: string): boolean {
  return /\.(ts|tsx|js|jsx|py|rb|rs|kt|scala|java|go|sql)$/i.test(file) && !isTestFile(file);
}

function sameRepo(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}
