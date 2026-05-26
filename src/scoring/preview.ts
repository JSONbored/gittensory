import type { ContributorEvidenceRecord, JsonValue, RepositoryRecord, ScoringModelSnapshotRecord, ScorePreviewRecord } from "../types";
import { nowIso } from "../utils/json";

export type ScorePreviewInput = {
  repoFullName: string;
  targetType?: ScorePreviewRecord["targetType"];
  targetKey?: string | undefined;
  contributorLogin?: string | undefined;
  labels?: string[] | undefined;
  linkedIssueMode?: "none" | "standard" | "maintainer" | undefined;
  sourceTokenScore?: number | undefined;
  totalTokenScore?: number | undefined;
  sourceLines?: number | undefined;
  testTokenScore?: number | undefined;
  nonCodeTokenScore?: number | undefined;
  existingContributorTokenScore?: number | undefined;
  openPrCount?: number | undefined;
  credibility?: number | undefined;
  changesRequestedCount?: number | undefined;
  fixedBaseScore?: number | undefined;
  metadataOnly?: boolean | undefined;
};

export type ScorePreviewResult = {
  repoFullName: string;
  generatedAt: string;
  scoringModelSnapshotId: string;
  activeModel: ScoringModelSnapshotRecord["activeModel"];
  privateOnly: true;
  laneMath: {
    repoEmissionShare: number;
    ossEmissionShare: number;
    repoSlice: number;
    directPrSlice: number;
    issueDiscoverySlice: number;
    issueDiscoveryShare: number;
  };
  scoreEstimate: {
    baseScore: number;
    densityMultiplier: number;
    contributionBonus: number;
    labelMultiplier: number;
    issueMultiplier: number;
    credibilityMultiplier: number;
    reviewPenaltyMultiplier: number;
    openPrMultiplier: number;
    estimatedMergedScore: number;
    pendingSaturationScore: number;
  };
  gates: {
    baseTokenGatePassed: boolean;
    openPrThreshold: number;
    openPrCount: number;
    collateralFraction: number;
    credibilityFloor: number;
    credibilityObserved: number;
  };
  warnings: string[];
  assumptions: string[];
  recommendation: {
    level: "strong_fit" | "reasonable_fit" | "needs_work" | "hold";
    actions: string[];
  };
};

export function buildScorePreview(args: {
  input: ScorePreviewInput;
  repo: RepositoryRecord | null;
  snapshot: ScoringModelSnapshotRecord;
  contributorEvidence?: ContributorEvidenceRecord | null | undefined;
}): ScorePreviewResult {
  const constants = { ...args.snapshot.constants };
  const config = args.repo?.registryConfig;
  const emissionShare = clamp(config?.emissionShare ?? 0, 0, 1);
  const issueDiscoveryShare = clamp(config?.issueDiscoveryShare ?? 0, 0, 1);
  const ossEmissionShare = constant(constants, "OSS_EMISSION_SHARE", 0.9);
  const repoSlice = emissionShare * ossEmissionShare;
  const directPrSlice = repoSlice * (1 - issueDiscoveryShare);
  const issueDiscoverySlice = repoSlice * issueDiscoveryShare;

  const sourceTokenScore = nonNegative(args.input.sourceTokenScore);
  const totalTokenScore = nonNegative(args.input.totalTokenScore ?? sourceTokenScore + nonNegative(args.input.testTokenScore) + nonNegative(args.input.nonCodeTokenScore));
  const sourceLines = Math.max(1, nonNegative(args.input.sourceLines ?? sourceTokenScore));
  const fixedBaseScore = args.input.fixedBaseScore ?? config?.fixedBaseScore ?? undefined;
  const rawDensity = sourceTokenScore / sourceLines;
  const densityMultiplier = clamp(rawDensity || 0, 0, constant(constants, "MAX_CODE_DENSITY_MULTIPLIER", 1.15));
  const baseTokenGatePassed = sourceTokenScore >= constant(constants, "MIN_TOKEN_SCORE_FOR_BASE_SCORE", 5);
  const contributionBonus =
    clamp(totalTokenScore / constant(constants, "CONTRIBUTION_SCORE_FOR_FULL_BONUS", 1500), 0, 1) *
    constant(constants, "MAX_CONTRIBUTION_BONUS", 25);
  const baseScore =
    fixedBaseScore !== undefined
      ? fixedBaseScore
      : (baseTokenGatePassed ? constant(constants, "MERGED_PR_BASE_SCORE", 25) * densityMultiplier : 0) + contributionBonus;
  const labelMultiplier = selectLabelMultiplier(args.input.labels ?? [], config?.labelMultipliers ?? {}, config?.defaultLabelMultiplier ?? 1);
  const issueMultiplier = selectIssueMultiplier(args.input.linkedIssueMode ?? "none", constants);
  const credibilityObserved = clamp(args.input.credibility ?? inferCredibility(args.contributorEvidence), 0, 1);
  const credibilityFloor = constant(constants, "MIN_CREDIBILITY", 0.8);
  const credibilityMultiplier = credibilityObserved >= credibilityFloor ? 1 : credibilityObserved / credibilityFloor;
  const changesRequestedCount = nonNegative(args.input.changesRequestedCount);
  const reviewPenaltyMultiplier = clamp(1 - changesRequestedCount * constant(constants, "REVIEW_PENALTY_RATE", 0.15), 0, 1);
  const openPrCount = nonNegative(args.input.openPrCount);
  const openPrThreshold = Math.min(
    constant(constants, "MAX_OPEN_PR_THRESHOLD", 30),
    constant(constants, "EXCESSIVE_PR_PENALTY_BASE_THRESHOLD", 2) +
      Math.floor((nonNegative(args.input.existingContributorTokenScore) + totalTokenScore) / constant(constants, "OPEN_PR_THRESHOLD_TOKEN_SCORE", 300)),
  );
  const openPrMultiplier = openPrCount <= openPrThreshold ? 1 : 0;
  const estimatedMergedScore = roundScore(baseScore * labelMultiplier * issueMultiplier * credibilityMultiplier * reviewPenaltyMultiplier * openPrMultiplier);
  const pendingSaturationScore = roundScore(
    constant(constants, "MERGED_PR_BASE_SCORE", 25) * (1 - Math.exp(-sourceTokenScore / constant(constants, "SRC_TOK_SATURATION_SCALE", 58))) +
      clamp(totalTokenScore / constant(constants, "CONTRIBUTION_SCORE_FOR_FULL_BONUS", 1500), 0, 1) * 5,
  );

  const warnings = [
    ...(!args.repo?.isRegistered ? ["Repository is not registered in the local Gittensory cache."] : []),
    ...(emissionShare <= 0 ? ["Repository has no active allocation in the current registry snapshot."] : []),
    ...(args.input.metadataOnly ? ["Preview used metadata-only inputs, so token and density estimates are rough."] : []),
    ...(!baseTokenGatePassed ? ["Source token score does not pass the current base-score token gate."] : []),
    ...(openPrMultiplier === 0 ? ["Open PR count exceeds the current threshold assumption."] : []),
    ...(credibilityMultiplier < 1 ? ["Credibility assumption is below the current floor."] : []),
    ...(reviewPenaltyMultiplier < 1 ? ["Change-request history reduces the estimate."] : []),
  ];
  const actions = [
    ...(!baseTokenGatePassed ? ["Increase meaningful source change size or scope clarity before relying on this preview."] : []),
    ...(openPrMultiplier === 0 ? ["Land or close existing open PRs before opening more concurrent work."] : []),
    ...(reviewPenaltyMultiplier < 1 ? ["Reduce review churn with tighter tests and clearer evidence."] : []),
    ...(labelMultiplier <= 1 && Object.keys(config?.labelMultipliers ?? {}).length > 0 ? ["Check whether the change legitimately matches one of the repo's configured trusted labels."] : []),
  ];

  return {
    repoFullName: args.input.repoFullName,
    generatedAt: nowIso(),
    scoringModelSnapshotId: args.snapshot.id,
    activeModel: args.snapshot.activeModel,
    privateOnly: true,
    laneMath: {
      repoEmissionShare: emissionShare,
      ossEmissionShare,
      repoSlice: roundScore(repoSlice),
      directPrSlice: roundScore(directPrSlice),
      issueDiscoverySlice: roundScore(issueDiscoverySlice),
      issueDiscoveryShare,
    },
    scoreEstimate: {
      baseScore: roundScore(baseScore),
      densityMultiplier: roundScore(densityMultiplier),
      contributionBonus: roundScore(contributionBonus),
      labelMultiplier,
      issueMultiplier,
      credibilityMultiplier: roundScore(credibilityMultiplier),
      reviewPenaltyMultiplier: roundScore(reviewPenaltyMultiplier),
      openPrMultiplier,
      estimatedMergedScore,
      pendingSaturationScore,
    },
    gates: {
      baseTokenGatePassed,
      openPrThreshold,
      openPrCount,
      collateralFraction: constant(constants, "OPEN_PR_COLLATERAL_PERCENT", 0.2),
      credibilityFloor,
      credibilityObserved,
    },
    warnings,
    assumptions: [
      "Advisory preview only; tied to the recorded scoring model snapshot and cached Gittensory data.",
      "No future outcome or exact payout is guaranteed.",
      "Private API/MCP output only; public comments intentionally omit these details.",
    ],
    recommendation: {
      level: warnings.some((warning) => /not registered|no active|exceeds/i.test(warning))
        ? "hold"
        : estimatedMergedScore >= 30 && warnings.length === 0
          ? "strong_fit"
          : estimatedMergedScore >= 15
            ? "reasonable_fit"
            : "needs_work",
      actions: actions.length > 0 ? actions : ["Keep the PR focused, linked, tested, and easy for maintainers to review."],
    },
  };
}

export function makeScorePreviewRecord(input: ScorePreviewInput, snapshot: ScoringModelSnapshotRecord, result: ScorePreviewResult): ScorePreviewRecord {
  return {
    id: crypto.randomUUID(),
    scoringModelSnapshotId: snapshot.id,
    repoFullName: input.repoFullName,
    targetType: input.targetType ?? "planned_pr",
    targetKey: input.targetKey ?? `${input.repoFullName}:${input.targetType ?? "planned_pr"}:${Date.now()}`,
    contributorLogin: input.contributorLogin,
    input: input as unknown as Record<string, JsonValue>,
    result: result as unknown as Record<string, JsonValue>,
    generatedAt: result.generatedAt,
  };
}

function selectLabelMultiplier(labels: string[], multipliers: Record<string, number>, fallback: number): number {
  const normalized = new Set(labels.map((label) => label.toLowerCase()));
  return Math.max(
    fallback || 1,
    ...Object.entries(multipliers).flatMap(([label, multiplier]) => (normalized.has(label.toLowerCase()) ? [multiplier] : [])),
  );
}

function selectIssueMultiplier(mode: "none" | "standard" | "maintainer", constants: Record<string, number>): number {
  if (mode === "maintainer") return constant(constants, "MAINTAINER_ISSUE_MULTIPLIER", 1.66);
  if (mode === "standard") return constant(constants, "STANDARD_ISSUE_MULTIPLIER", 1.33);
  return 1;
}

function inferCredibility(evidence?: ContributorEvidenceRecord | null): number {
  const payload = evidence?.payload;
  const merged = Number(payload?.mergedPullRequests ?? 0);
  const stale = Number(payload?.stalePullRequests ?? 0);
  const unlinked = Number(payload?.unlinkedPullRequests ?? 0);
  if (!Number.isFinite(merged)) return 0.8;
  return clamp(0.75 + merged * 0.04 - stale * 0.03 - unlinked * 0.02, 0.25, 1);
}

function constant(constants: Record<string, number>, key: string, fallback: number): number {
  const value = constants[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function roundScore(value: number): number {
  return Math.round(value * 10000) / 10000;
}
