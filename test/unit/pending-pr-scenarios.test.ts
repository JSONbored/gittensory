import { describe, expect, it } from "vitest";
import { sanitizePublicComment } from "../../src/github/commands";
import {
  classifyOpenPullRequest,
  detectPendingPrScenario,
} from "../../src/scoring/pending-pr-scenarios";
import { buildScorePreview } from "../../src/scoring/preview";
import type { PullRequestRecord, PullRequestReviewRecord, ScoringModelSnapshotRecord } from "../../src/types";
import type { RoleContext } from "../../src/signals/engine";

const outsideContributorRole: RoleContext = {
  login: "miner-a",
  repoFullName: "entrius/allways-ui",
  generatedAt: "2026-05-28T00:00:00.000Z",
  role: "outside_contributor",
  maintainerLane: false,
  normalContributorEvidenceAllowed: true,
  source: "cache",
  association: "NONE",
  reasons: [],
  guidance: "contributor",
};

const maintainerRole: RoleContext = {
  ...outsideContributorRole,
  login: "repo-owner",
  role: "owner",
  maintainerLane: true,
  normalContributorEvidenceAllowed: false,
  source: "repo_owner_match",
  guidance: "maintainer",
};

function pr(overrides: Partial<PullRequestRecord> & Pick<PullRequestRecord, "number">): PullRequestRecord {
  return {
    repoFullName: "entrius/allways-ui",
    title: `PR #${overrides.number}`,
    state: "open",
    authorLogin: "miner-a",
    labels: [],
    linkedIssues: [1],
    createdAt: "2026-05-20T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
    ...overrides,
  };
}

function approvedReview(pullNumber: number): PullRequestReviewRecord {
  return {
    id: `review-${pullNumber}`,
    repoFullName: "entrius/allways-ui",
    pullNumber,
    state: "APPROVED",
    payload: {},
  };
}

describe("pending PR scenario detection", () => {
  it("treats approved-but-unmerged PRs as merge-ready pending work", () => {
    const detection = detectPendingPrScenario({
      login: "miner-a",
      repoFullName: "entrius/allways-ui",
      pullRequests: [pr({ number: 11 }), pr({ number: 12, title: "blocked work" })],
      roleContext: outsideContributorRole,
      openPrCount: 3,
      reviewsByPullNumber: new Map([
        [11, [approvedReview(11)]],
        [12, [{ ...approvedReview(12), state: "CHANGES_REQUESTED" }]],
      ]),
      checksByPullNumber: new Map([
        [11, []],
        [12, []],
      ]),
    });
    expect(detection).toMatchObject({
      source: "github_observed",
      pendingMergedPrCount: 1,
      pendingClosedPrCount: 0,
      expectedOpenPrCountAfterMerge: 2,
    });
    expect(detection?.classified.find((entry) => entry.number === 12)?.classification).toBe("blocked");
  });

  it("does not treat draft, stale, or maintainer-lane PRs as likely-to-land", () => {
    const staleDate = new Date(Date.now() - 20 * 86_400_000).toISOString();
    const classified = [
      classifyOpenPullRequest({
        pr: pr({ number: 1, title: "Draft: experiment", labels: ["draft"] }),
        roleContext: outsideContributorRole,
        reviews: [approvedReview(1)],
        checks: [],
      }),
      classifyOpenPullRequest({
        pr: pr({ number: 2, updatedAt: staleDate, createdAt: staleDate }),
        roleContext: outsideContributorRole,
        reviews: [approvedReview(2)],
        checks: [],
      }),
      classifyOpenPullRequest({
        pr: pr({ number: 3, authorAssociation: "MEMBER" }),
        roleContext: outsideContributorRole,
        reviews: [approvedReview(3)],
        checks: [],
      }),
      classifyOpenPullRequest({
        pr: pr({ number: 4 }),
        roleContext: maintainerRole,
        reviews: [approvedReview(4)],
        checks: [],
      }),
    ];
    expect(classified.map((entry) => entry.classification)).toEqual(["draft", "stale_likely_close", "maintainer_lane", "maintainer_lane"]);
  });

  it("labels user-supplied assumptions separately from GitHub-observed state", () => {
    const user = detectPendingPrScenario({
      login: "miner-a",
      repoFullName: "entrius/allways-ui",
      pullRequests: [pr({ number: 9 })],
      roleContext: outsideContributorRole,
      userSupplied: { pendingMergedPrCount: 2, scenarioNotes: ["manual assumption"] },
    });
    expect(user?.source).toBe("user_supplied");

    const observed = detectPendingPrScenario({
      login: "miner-a",
      repoFullName: "entrius/allways-ui",
      pullRequests: [pr({ number: 10 })],
      roleContext: outsideContributorRole,
      reviewsByPullNumber: new Map([[10, [approvedReview(10)]]]),
      checksByPullNumber: new Map([[10, []]]),
    });
    expect(observed?.source).toBe("github_observed");
    expect(observed?.scenarioNotes[0]).toMatch(/GitHub-observed/i);
  });

  it("keeps effective score distinct from underlying potential in observed after-pending scenario", () => {
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
      },
      programmingLanguages: {},
      registrySnapshotId: "registry-fixture",
      warnings: [],
      payload: {},
    };
    const preview = buildScorePreview({
      repo: {
        fullName: "entrius/allways-ui",
        owner: "entrius",
        name: "allways-ui",
        isInstalled: false,
        isRegistered: true,
        isPrivate: false,
        registryConfig: { repo: "entrius/allways-ui", emissionShare: 0.02, issueDiscoveryShare: 0.25, labelMultipliers: {}, maintainerCut: 0, raw: {} },
      },
      snapshot,
      input: {
        repoFullName: "entrius/allways-ui",
        sourceTokenScore: 60,
        totalTokenScore: 90,
        sourceLines: 50,
        openPrCount: 3,
        credibility: 1,
        pendingMergedPrCount: 1,
        pendingScenarioObserved: true,
      },
    });
    const afterPending = preview.scenarioPreviews.find((scenario) => scenario.name === "afterPendingMerges");
    expect(preview.effectiveEstimatedScore).toBe(0);
    expect(preview.underlyingPotentialScore).toBeGreaterThan(0);
    expect(afterPending?.source).toBe("github_observed");
    expect(afterPending?.effectiveEstimatedScore).toBeGreaterThan(0);
  });

  it("sanitizes public comment text that mentions score, reward, wallet, or hotkey language", () => {
    const dirty =
      "Estimated score 42, reward estimate, wallet abc, hotkey xyz, payout farming, reviewability ranking, raw trust score.";
    expect(sanitizePublicComment(dirty)).not.toMatch(/estimated score|reward estimate|wallet|hotkey|payout|farming|reviewability|raw trust score/i);
    expect(sanitizePublicComment(dirty)).toContain("private context");
  });
});
