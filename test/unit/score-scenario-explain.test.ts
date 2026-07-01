import { describe, expect, it } from "vitest";
import { buildScorePreview, type ScorePreviewResult, type ScoreScenarioPreview } from "../../src/scoring/preview";
import { explainScoreScenarios } from "../../src/services/score-scenario-explain";
import type { RepositoryRecord, ScoringModelSnapshotRecord } from "../../src/types";

const FORBIDDEN = /\b(wallet|hotkey|coldkey|mnemonic|farming|payout|raw[-_\s]?trust)\b/i;

const snapshot: ScoringModelSnapshotRecord = {
  id: "score-model-fixture",
  sourceKind: "test",
  sourceUrl: "fixture://constants.py",
  fetchedAt: "2026-05-23T00:00:00.000Z",
  activeModel: "current_density_model",
  constants: {
    OSS_EMISSION_SHARE: 0.9,
    MERGED_PR_BASE_SCORE: 25,
    MIN_TOKEN_SCORE_FOR_BASE_SCORE: 5,
    MAX_CODE_DENSITY_MULTIPLIER: 1.15,
    MAX_CONTRIBUTION_BONUS: 25,
    CONTRIBUTION_SCORE_FOR_FULL_BONUS: 1500,
    STANDARD_ISSUE_MULTIPLIER: 1.33,
    MAINTAINER_ISSUE_MULTIPLIER: 1.66,
    MIN_CREDIBILITY: 0.8,
    REVIEW_PENALTY_RATE: 0.15,
    EXCESSIVE_PR_PENALTY_BASE_THRESHOLD: 2,
    OPEN_PR_THRESHOLD_TOKEN_SCORE: 300,
    MAX_OPEN_PR_THRESHOLD: 30,
    OPEN_PR_COLLATERAL_PERCENT: 0.2,
    SRC_TOK_SATURATION_SCALE: 58,
    TOTAL_TOK_SATURATION_SCALE: 58,
  },
  payload: {},
  programmingLanguages: {},
  warnings: [],
};

const repo: RepositoryRecord = {
  fullName: "octo/demo",
  owner: "octo",
  name: "demo",
  isInstalled: false,
  isRegistered: true,
  isPrivate: false,
  registryConfig: {
    repo: "octo/demo",
    emissionShare: 0.02,
    issueDiscoveryShare: 0.25,
    labelMultipliers: { bug: 1.2 },
    maintainerCut: 0,
    raw: {},
  },
};

function scenarioFromBase(
  base: ScorePreviewResult,
  name: ScoreScenarioPreview["name"],
  overrides: Partial<ScoreScenarioPreview>,
): ScoreScenarioPreview {
  const template = base.scenarioPreviews.find((scenario) => scenario.name === name) ?? base.scenarioPreviews[0]!;
  return { ...template, ...overrides, name };
}

function withScenarios(
  base: ScorePreviewResult,
  args: {
    effectiveEstimatedScore: number;
    scoreabilityStatus: ScorePreviewResult["scoreabilityStatus"];
    scenarios: ScoreScenarioPreview[];
  },
): ScorePreviewResult {
  return {
    ...base,
    effectiveEstimatedScore: args.effectiveEstimatedScore,
    scoreabilityStatus: args.scoreabilityStatus,
    scenarioPreviews: args.scenarios,
  };
}

function basePreview(): ScorePreviewResult {
  return buildScorePreview({
    repo,
    snapshot,
    input: {
      repoFullName: repo.fullName,
      contributorLogin: "miner",
      sourceTokenScore: 40,
      totalTokenScore: 60,
      sourceLines: 80,
      openPrCount: 0,
      credibility: 1,
      linkedIssueMode: "none",
    },
  });
}

describe("explainScoreScenarios", () => {
  it("ranks bestReasonableCase when open-PR pressure fully blocks the current preview", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        contributorLogin: "miner",
        sourceTokenScore: 40,
        totalTokenScore: 60,
        sourceLines: 80,
        openPrCount: 50,
        credibility: 0.95,
        linkedIssueMode: "none",
      },
    });

    const explanation = explainScoreScenarios(preview);
    expect(preview.scoreabilityStatus).toMatch(/blocked|conditionally_scoreable/);
    expect(explanation.recommendedPath.scenario).toBe("bestReasonableCase");
    expect(explanation.recommendedPath.lever).toMatch(/gate cleanups|plausible/i);
    expect(explanation.scenarios.some((card) => card.name === "bestReasonableCase" && card.leverageScore > 0)).toBe(true);
    expect(explanation.scenarios.every((card) => card.name !== "current")).toBe(true);
    expect(JSON.stringify(explanation)).not.toMatch(FORBIDDEN);
  });

  it("prefers afterPendingMerges when pending merge pressure is caller-supplied", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        contributorLogin: "miner",
        sourceTokenScore: 40,
        totalTokenScore: 60,
        sourceLines: 80,
        openPrCount: 4,
        pendingMergedPrCount: 2,
        expectedOpenPrCountAfterMerge: 2,
        projectedCredibility: 0.95,
        credibility: 0.5,
        linkedIssueMode: "none",
      },
    });

    const explanation = explainScoreScenarios(preview);
    const pending = explanation.scenarios.find((card) => card.name === "afterPendingMerges");
    const clean = explanation.scenarios.find((card) => card.name === "cleanGates");
    expect(pending?.leverageScore ?? 0).toBeGreaterThan(0);
    expect((pending?.leverageScore ?? 0) >= (clean?.leverageScore ?? 0)).toBe(true);
    expect(explanation.headline).toMatch(/conditionally scoreable|cleanup path/i);
  });

  it("surfaces linkedIssueFixed when linked issue context is invalid", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        contributorLogin: "miner",
        sourceTokenScore: 40,
        totalTokenScore: 60,
        sourceLines: 80,
        openPrCount: 1,
        credibility: 0.95,
        linkedIssueMode: "standard",
        linkedIssueContext: { status: "invalid", source: "github_cache", issueNumbers: [12], reason: "Issue closed" },
      },
    });

    const explanation = explainScoreScenarios(preview);
    const linked = explanation.scenarios.find((card) => card.name === "linkedIssueFixed");
    expect(linked?.lever).toMatch(/linked issue|solved-by-PR|mirror metadata/i);
    expect(linked?.summary).toMatch(/linked issue validated|Linked issue validated/i);
  });

  it("uses a neutral headline when no scenario improves the current preview", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        contributorLogin: "miner",
        sourceTokenScore: 40,
        totalTokenScore: 60,
        sourceLines: 80,
        openPrCount: 0,
        credibility: 1,
        linkedIssueMode: "none",
      },
    });

    const explanation = explainScoreScenarios(preview);
    expect(explanation.scoreabilityStatus).toBe("scoreable");
    expect(explanation.headline).toMatch(/scoreable|optional cleanup/i);
    expect(explanation.recommendedPath.scenario).toBe("current");
    expect(explanation.scenarios.every((card) => card.leverageScore === 0)).toBe(true);
  });

  it("expands gate deltas into actionable narratives", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        contributorLogin: "miner",
        sourceTokenScore: 40,
        totalTokenScore: 60,
        sourceLines: 80,
        openPrCount: 50,
        openIssueCount: 50,
        credibility: 0.5,
        mergedPullRequests: 1,
        linkedIssueMode: "standard",
        linkedIssueContext: { status: "raw", source: "github_cache", issueNumbers: [12] },
      },
    });

    const explanation = explainScoreScenarios(preview);
    expect(explanation.gateDeltaNarratives.length).toBeGreaterThan(0);
    for (const narrative of explanation.gateDeltaNarratives) {
      expect(narrative.narrative.length).toBeGreaterThan(0);
      expect(narrative.lever.length).toBeGreaterThan(0);
    }
    expect(JSON.stringify(explanation)).not.toMatch(FORBIDDEN);
  });

  it("assigns hold band when repo allocation is inactive", () => {
    const inactiveRepo: RepositoryRecord = {
      ...repo,
      registryConfig: { ...repo.registryConfig!, emissionShare: 0 },
    };
    const preview = buildScorePreview({
      repo: inactiveRepo,
      snapshot,
      input: {
        repoFullName: inactiveRepo.fullName,
        contributorLogin: "miner",
        sourceTokenScore: 40,
        totalTokenScore: 60,
        sourceLines: 80,
        openPrCount: 0,
        credibility: 1,
        linkedIssueMode: "none",
      },
    });

    const explanation = explainScoreScenarios(preview);
    expect(preview.scoreabilityStatus).toBe("hold");
    expect(explanation.headline).toMatch(/hold|registration|allocation/i);
    expect(explanation.scenarios.some((card) => card.band === "hold")).toBe(true);
  });

  it("uses the blocked headline when cleanup paths exist but the preview stays blocked", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        contributorLogin: "miner",
        sourceTokenScore: 40,
        totalTokenScore: 60,
        sourceLines: 80,
        openPrCount: 50,
        credibility: 0.95,
        linkedIssueMode: "none",
      },
    });

    const explanation = explainScoreScenarios(preview);
    expect(explanation.scenarios.some((card) => card.leverageScore > 0)).toBe(true);
    if (preview.scoreabilityStatus === "blocked") {
      expect(explanation.headline).toMatch(/blocked|cleanup sequence/i);
    }
  });

  it("labels github_observed scenario cards and blocked summaries with gate codes", () => {
    const preview = buildScorePreview({
      repo,
      snapshot,
      input: {
        repoFullName: repo.fullName,
        contributorLogin: "miner",
        sourceTokenScore: 40,
        totalTokenScore: 60,
        sourceLines: 80,
        openPrCount: 4,
        approvedPrCount: 2,
        pendingScenarioObserved: true,
        credibility: 0.5,
        linkedIssueMode: "none",
      },
    });

    const explanation = explainScoreScenarios(preview);
    const approved = explanation.scenarios.find((card) => card.name === "afterApprovedPrsMerge");
    expect(approved?.source).toBe("github_observed");
    expect(approved?.summary).toMatch(/remains blocked by open_pr_threshold|improves the preview versus current state|clears blocking gates/i);
    expect(explanation.recommendedPath.reason.length).toBeGreaterThan(0);
  });

  it("uses the neutral headline when blocked and no scenario improves the preview", () => {
    const base = basePreview();
    const openPrBlocker = [{ code: "open_pr_threshold" as const, severity: "blocker" as const, detail: "Too many open PRs." }];
    const preview = withScenarios(base, {
      effectiveEstimatedScore: 0,
      scoreabilityStatus: "blocked",
      scenarios: [
        scenarioFromBase(base, "current", { source: "current_data", effectiveEstimatedScore: 0, blockedBy: openPrBlocker }),
        scenarioFromBase(base, "cleanGates", { source: "user_supplied", effectiveEstimatedScore: 0, blockedBy: openPrBlocker }),
        scenarioFromBase(base, "afterPendingMerges", { source: "user_supplied", effectiveEstimatedScore: 0, blockedBy: openPrBlocker }),
        scenarioFromBase(base, "afterApprovedPrsMerge", { source: "github_observed", effectiveEstimatedScore: 0, blockedBy: openPrBlocker }),
        scenarioFromBase(base, "afterStalePrsClose", { source: "user_supplied", effectiveEstimatedScore: 0, blockedBy: openPrBlocker }),
        scenarioFromBase(base, "linkedIssueFixed", { source: "gittensory_projection", effectiveEstimatedScore: 0, blockedBy: openPrBlocker }),
        scenarioFromBase(base, "bestReasonableCase", { source: "gittensory_projection", effectiveEstimatedScore: 0, blockedBy: openPrBlocker }),
      ],
    });

    const explanation = explainScoreScenarios(preview);
    expect(explanation.headline).toMatch(/No scenario path improves the current preview/i);
    expect(explanation.recommendedPath.scenario).toBe("current");
  });

  it("uses the blocked headline when cleanup paths exist for a blocked preview", () => {
    const base = basePreview();
    const openPrBlocker = [{ code: "open_pr_threshold" as const, severity: "blocker" as const, detail: "Too many open PRs." }];
    const preview = withScenarios(base, {
      effectiveEstimatedScore: 0,
      scoreabilityStatus: "blocked",
      scenarios: [
        scenarioFromBase(base, "current", { source: "current_data", effectiveEstimatedScore: 0, blockedBy: openPrBlocker }),
        scenarioFromBase(base, "cleanGates", { source: "user_supplied", effectiveEstimatedScore: 8, blockedBy: openPrBlocker }),
        scenarioFromBase(base, "afterPendingMerges", { source: "user_supplied", effectiveEstimatedScore: 0, blockedBy: openPrBlocker }),
        scenarioFromBase(base, "afterApprovedPrsMerge", { source: "github_observed", effectiveEstimatedScore: 0, blockedBy: openPrBlocker }),
        scenarioFromBase(base, "afterStalePrsClose", { source: "user_supplied", effectiveEstimatedScore: 0, blockedBy: openPrBlocker }),
        scenarioFromBase(base, "linkedIssueFixed", { source: "gittensory_projection", effectiveEstimatedScore: 0, blockedBy: openPrBlocker }),
        scenarioFromBase(base, "bestReasonableCase", { source: "gittensory_projection", effectiveEstimatedScore: 0, blockedBy: openPrBlocker }),
      ],
    });

    const explanation = explainScoreScenarios(preview);
    expect(explanation.headline).toMatch(/blocked; ranked scenarios show the highest-leverage cleanup sequence/i);
    const clean = explanation.scenarios.find((card) => card.name === "cleanGates");
    expect(clean?.band).toBe("conditionally_scoreable");
    expect(clean?.summary).toMatch(/improves the preview versus current state/i);
    expect(clean?.unlockDelta).toMatch(/improves versus current/i);
  });

  it("describes negative scenario deltas and scoreable unlock reasons", () => {
    const base = basePreview();
    const preview = withScenarios(base, {
      effectiveEstimatedScore: 10,
      scoreabilityStatus: "conditionally_scoreable",
      scenarios: [
        scenarioFromBase(base, "current", { source: "current_data", effectiveEstimatedScore: 10, blockedBy: [] }),
        scenarioFromBase(base, "cleanGates", { source: "user_supplied", effectiveEstimatedScore: 20, blockedBy: [] }),
        scenarioFromBase(base, "afterStalePrsClose", { source: "user_supplied", effectiveEstimatedScore: 5, blockedBy: [{ code: "open_pr_threshold", severity: "blocker", detail: "Still blocked." }] }),
        scenarioFromBase(base, "afterPendingMerges", { source: "user_supplied", effectiveEstimatedScore: 10, blockedBy: [] }),
        scenarioFromBase(base, "afterApprovedPrsMerge", { source: "github_observed", effectiveEstimatedScore: 10, blockedBy: [] }),
        scenarioFromBase(base, "linkedIssueFixed", { source: "gittensory_projection", effectiveEstimatedScore: 10, blockedBy: [] }),
        scenarioFromBase(base, "bestReasonableCase", { source: "gittensory_projection", effectiveEstimatedScore: 10, blockedBy: [] }),
      ],
    });

    const explanation = explainScoreScenarios(preview);
    const stale = explanation.scenarios.find((card) => card.name === "afterStalePrsClose");
    expect(stale?.unlockDelta).toMatch(/does not improve versus current/i);
    expect(explanation.recommendedPath.scenario).toBe("cleanGates");
    expect(explanation.recommendedPath.reason).toMatch(/clears blocking gates under user supplied assumptions/i);
  });

  it("summarizes blocked scenarios without blocker codes when only reducers remain", () => {
    const base = basePreview();
    const reducerOnly = [{ code: "review_penalty" as const, severity: "reducer" as const, detail: "Review churn." }];
    const preview = withScenarios(base, {
      effectiveEstimatedScore: 0,
      scoreabilityStatus: "blocked",
      scenarios: [
        scenarioFromBase(base, "current", { source: "current_data", effectiveEstimatedScore: 0, blockedBy: reducerOnly }),
        scenarioFromBase(base, "cleanGates", { source: "user_supplied", effectiveEstimatedScore: 0, blockedBy: reducerOnly }),
        scenarioFromBase(base, "afterPendingMerges", { source: "user_supplied", effectiveEstimatedScore: 0, blockedBy: reducerOnly }),
        scenarioFromBase(base, "afterApprovedPrsMerge", { source: "github_observed", effectiveEstimatedScore: 0, blockedBy: reducerOnly }),
        scenarioFromBase(base, "afterStalePrsClose", { source: "user_supplied", effectiveEstimatedScore: 0, blockedBy: reducerOnly }),
        scenarioFromBase(base, "linkedIssueFixed", { source: "gittensory_projection", effectiveEstimatedScore: 0, blockedBy: reducerOnly }),
        scenarioFromBase(base, "bestReasonableCase", { source: "gittensory_projection", effectiveEstimatedScore: 0, blockedBy: reducerOnly }),
      ],
    });

    const explanation = explainScoreScenarios(preview);
    expect(explanation.scenarios.every((card) => card.band === "blocked")).toBe(true);
    expect(explanation.scenarios[0]?.summary).toMatch(/remains blocked or reduced under stated assumptions/i);
  });
});
