// Branch-coverage tests for the reward-risk engine module (#2281). The verbatim lift preserved a handful of
// deterministic tie-break / defensive branches the pre-existing suite never exercised; because the module is
// brand-new to the engine package, codecov/patch measures every one of them. These cases drive each remaining
// branch directly (no behavior change to the module itself).
import { describe, expect, it } from "vitest";
import {
  buildContributorFit,
  buildContributorOutcomeHistory,
  buildContributorProfile,
  buildContributorScoringProfile,
} from "../../src/signals/engine";
import { buildContributorRewardRiskStrategy, buildRepoRewardRisk, rewardRiskFreshnessInternals } from "../../src/signals/reward-risk";
import type {
  ContributorRepoStatRecord,
  IssueRecord,
  PullRequestRecord,
  RegistryRepoConfig,
  RepositoryRecord,
  ScoringModelSnapshotRecord,
} from "../../src/types";

function repo(fullName: string, overrides: Partial<RegistryRepoConfig> = {}): RepositoryRecord {
  const [owner, name] = fullName.split("/") as [string, string];
  return {
    fullName,
    owner,
    name,
    isInstalled: true,
    isRegistered: true,
    isPrivate: false,
    defaultBranch: "main",
    registryConfig: { repo: fullName, emissionShare: 0.02, issueDiscoveryShare: 0, labelMultipliers: {}, trustedLabelPipeline: false, maintainerCut: 0, raw: {}, ...overrides },
  };
}

function pr(repoFullName: string, number: number, title: string, overrides: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return { repoFullName, number, title, state: "open", authorLogin: "dev", authorAssociation: "NONE", labels: [], linkedIssues: [], body: "", updatedAt: new Date().toISOString(), ...overrides };
}

function scoringSnapshot(): ScoringModelSnapshotRecord {
  return { id: "branch-cov", sourceKind: "test", sourceUrl: "fixture://branch-cov", fetchedAt: "2026-05-25T00:00:00.000Z", activeModel: "current_density_model", constants: {}, programmingLanguages: {}, warnings: [], payload: {} };
}

const github = { login: "dev", topLanguages: ["TypeScript"], source: "github" as const };

describe("reward-risk engine branch coverage (#2281)", () => {
  it("bestFitLabels breaks an equal-multiplier tie by label name", () => {
    // Two labels with the SAME multiplier force the sort comparator's `|| localeCompare` fallback.
    const labels = rewardRiskFreshnessInternals.bestFitLabels(repo("owner/tie", { labelMultipliers: { zebra: 1.5, alpha: 1.5 } }));
    expect(labels).toEqual(["alpha"]);
  });

  it("reviewChurnRisk reports high risk when the repo-specific closed-PR rate is high", () => {
    const profile = buildContributorProfile("dev", github, [], []);
    const churnRepo = repo("owner/churn");
    // Two closed + one merged PR => closedPullRequestRate ~0.67 => reviewChurnRisk risk >= 45 => "high".
    const outcomeHistory = buildContributorOutcomeHistory({
      login: "dev",
      profile,
      repositories: [churnRepo],
      pullRequests: [
        pr(churnRepo.fullName, 30, "Closed one", { state: "closed" }),
        pr(churnRepo.fullName, 31, "Closed two", { state: "closed" }),
        pr(churnRepo.fullName, 32, "Merged", { state: "merged", mergedAt: "2026-05-20T00:00:00.000Z" }),
      ],
      issues: [],
      repoStats: [],
    });
    const fit = buildContributorFit(profile, [churnRepo], [], [], [], []);
    const scoringProfile = buildContributorScoringProfile({ login: "dev", fit, scoringSnapshot: scoringSnapshot() });
    const analysis = buildRepoRewardRisk({
      login: "dev",
      repo: churnRepo,
      repoFullName: churnRepo.fullName,
      profile,
      outcomeHistory,
      scoringSnapshot: scoringSnapshot(),
      scoringProfile,
      issues: [],
      pullRequests: [],
    });
    expect(analysis.riskBreakdown.reviewChurnRisk).toBe("high");
  });

  it("reviewChurnRisk reports medium risk for a moderate closed-PR rate", () => {
    const profile = buildContributorProfile("dev", github, [], []);
    const churnRepo = repo("owner/churn-mid");
    // One closed + two merged => closedPullRequestRate ~0.33 => risk in [20, 45) => "medium".
    const outcomeHistory = buildContributorOutcomeHistory({
      login: "dev",
      profile,
      repositories: [churnRepo],
      pullRequests: [
        pr(churnRepo.fullName, 40, "Closed one", { state: "closed" }),
        pr(churnRepo.fullName, 41, "Merged one", { state: "merged", mergedAt: "2026-05-20T00:00:00.000Z" }),
        pr(churnRepo.fullName, 42, "Merged two", { state: "merged", mergedAt: "2026-05-21T00:00:00.000Z" }),
      ],
      issues: [],
      repoStats: [],
    });
    const fit = buildContributorFit(profile, [churnRepo], [], [], [], []);
    const scoringProfile = buildContributorScoringProfile({ login: "dev", fit, scoringSnapshot: scoringSnapshot() });
    const analysis = buildRepoRewardRisk({
      login: "dev",
      repo: churnRepo,
      repoFullName: churnRepo.fullName,
      profile,
      outcomeHistory,
      scoringSnapshot: scoringSnapshot(),
      scoringProfile,
      issues: [],
      pullRequests: [],
    });
    expect(analysis.riskBreakdown.reviewChurnRisk).toBe("medium");
  });

  it("maintainer-cut readiness scores without the low-queue bonus when the owned repo's queue is not low", () => {
    // Owner === login => maintainer lane; a heavily loaded queue keeps queueHealth.level above "low",
    // exercising the `level === "low" ? 20 : 0` false branch.
    const ownedRepo = repo("dev/owned");
    const busyPrs = Array.from({ length: 14 }, (_, i) => pr(ownedRepo.fullName, i + 1, `Open work ${i}`, { authorLogin: `other${i}` }));
    const profile = buildContributorProfile("dev", github, [], []);
    const fit = buildContributorFit(profile, [ownedRepo], [], [], [], []);
    const scoringProfile = buildContributorScoringProfile({ login: "dev", fit, scoringSnapshot: scoringSnapshot() });
    const analysis = buildRepoRewardRisk({
      login: "dev",
      repo: ownedRepo,
      repoFullName: ownedRepo.fullName,
      profile,
      outcomeHistory: buildContributorOutcomeHistory({ login: "dev", profile, repositories: [ownedRepo], pullRequests: busyPrs, issues: [], repoStats: [] }),
      scoringSnapshot: scoringSnapshot(),
      scoringProfile,
      issues: [],
      pullRequests: busyPrs,
    });
    expect(analysis.roleContext.maintainerLane).toBe(true);
    expect(analysis.actions.some((a) => a.actionKind === "maintainer_cut_readiness")).toBe(true);
  });

  it("contributor strategy breaks analysis and action ties across two identical repos", () => {
    // Two byte-identical registered repos (differing only by name) produce equal analysisRank and equal
    // top-action (priorityScore, actionKind) pairs, exercising the localeCompare/ACTION_RANK tie-breaks in
    // both the repoAnalyses and topActions sorts, plus the fit.opportunities map callback.
    const repoA = repo("twin/aaa");
    const repoB = repo("twin/bbb");
    const profile = buildContributorProfile("dev", github, [], []);
    const stat = (repoFullName: string): ContributorRepoStatRecord => ({ login: "dev", repoFullName, pullRequests: 4, mergedPullRequests: 2, openPullRequests: 4, issues: 0, stalePullRequests: 0, unlinkedPullRequests: 0, dominantLabels: ["feature"] });
    const outcomeHistory = buildContributorOutcomeHistory({ login: "dev", profile, repositories: [repoA, repoB], pullRequests: [], issues: [], repoStats: [stat(repoA.fullName), stat(repoB.fullName)] });
    const fit = buildContributorFit(profile, [repoA, repoB], [], [], [], [stat(repoA.fullName), stat(repoB.fullName)]);
    const scoringProfile = buildContributorScoringProfile({ login: "dev", fit, scoringSnapshot: scoringSnapshot() });
    const fitWithOpportunities = {
      ...fit,
      opportunities: [
        { repoFullName: repoA.fullName, title: "Grabbable", fit: "good" as const, score: 40, lane: "direct_pr" as const, multiplierTier: "community" as const, availability: "ready" as const, reasons: [], warnings: [] },
      ],
    };
    const strategy = buildContributorRewardRiskStrategy({
      login: "dev",
      fit: fitWithOpportunities,
      scoringProfile,
      scoringSnapshot: scoringSnapshot(),
      outcomeHistory,
      repositories: [repoA, repoB],
      allIssues: [] as IssueRecord[],
      allPullRequests: [] as PullRequestRecord[],
    });
    expect(strategy.repoAnalyses).toHaveLength(2);
    // Deterministic tie-break => the two identical analyses come back in lexicographic repo order.
    expect(strategy.repoAnalyses.map((a) => a.repoFullName)).toEqual([repoA.fullName, repoB.fullName]);
  });
});
