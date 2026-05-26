import { describe, expect, it } from "vitest";
import { persistSignalSnapshot } from "../../src/db/repositories";
import {
  __decisionPackInternals,
  loadContributorDecisionPack,
  loadFreshContributorDecisionPack,
  repoDecisionFromPack,
  type ContributorDecisionPack,
  type RepoDecision,
} from "../../src/services/decision-pack";
import { createTestEnv } from "../helpers/d1";

describe("decision-pack service", () => {
  it("classifies score blockers, recommendations, actions, and explanations deterministically", () => {
    const maintainerRole = { maintainerLane: true } as any;
    const outsideRole = { maintainerLane: false } as any;
    const pressureOutcome = { openPullRequests: 6, closedPullRequestRate: 0.4, credibility: 0.5, maintainerLane: false, mergedPullRequests: 2, closedPullRequests: 3, validSolvedIssues: 1 } as any;
    const moderateOutcome = { openPullRequests: 3, closedPullRequestRate: 0.1, credibility: 1, maintainerLane: false, mergedPullRequests: 1, closedPullRequests: 0, validSolvedIssues: 0 } as any;

    expect(__decisionPackInternals.scoreBlockersFor("owner/repo", "inactive", maintainerRole, pressureOutcome).map((blocker) => blocker.code)).toEqual([
      "maintainer_lane",
      "inactive_or_unknown_lane",
      "open_pr_pressure",
      "closed_pr_credibility",
      "low_credibility",
    ]);
    expect(__decisionPackInternals.scoreBlockersFor("owner/issues", "issue_discovery", outsideRole, undefined).map((blocker) => blocker.code)).toEqual(["issue_discovery_only"]);

    expect(__decisionPackInternals.recommendationFor("direct_pr", maintainerRole, undefined, [])).toBe("maintainer_lane");
    expect(__decisionPackInternals.recommendationFor("direct_pr", outsideRole, pressureOutcome, [{ code: "open_pr_pressure", severity: "critical" } as any])).toBe("cleanup_first");
    expect(__decisionPackInternals.recommendationFor("inactive", outsideRole, undefined, [{ code: "inactive_or_unknown_lane", severity: "critical" } as any])).toBe("avoid_for_now");
    expect(__decisionPackInternals.recommendationFor("direct_pr", outsideRole, moderateOutcome, [])).toBe("cleanup_first");
    expect(__decisionPackInternals.recommendationFor("split", outsideRole, undefined, [])).toBe("pursue");
    expect(__decisionPackInternals.recommendationFor("issue_discovery", outsideRole, undefined, [])).toBe("watch");
    expect(__decisionPackInternals.recommendationFor("unknown", outsideRole, undefined, [])).toBe("avoid_for_now");

    const baseDecision = (recommendation: RepoDecision["recommendation"], lane = "direct_pr", priorityScore = 42): RepoDecision =>
      ({
        repoFullName: "owner/repo",
        recommendation,
        priorityScore,
        lane: { lane },
        whyThisHelps: [`${recommendation} helps`],
        nextActions: [`${recommendation} next`],
      }) as RepoDecision;
    expect(__decisionPackInternals.actionsForDecision(baseDecision("maintainer_lane")).map((action) => action.actionKind)).toEqual(["maintainer_lane_improve_repo", "maintainer_cut_readiness"]);
    expect(__decisionPackInternals.actionsForDecision(baseDecision("cleanup_first")).map((action) => action.actionKind)).toEqual(["cleanup_existing_prs", "land_existing_prs"]);
    expect(__decisionPackInternals.actionsForDecision(baseDecision("pursue")).map((action) => action.actionKind)).toEqual(["open_new_direct_pr"]);
    expect(__decisionPackInternals.actionsForDecision(baseDecision("watch", "issue_discovery")).map((action) => action.actionKind)).toEqual(["file_issue_discovery"]);
    expect(__decisionPackInternals.actionsForDecision(baseDecision("avoid_for_now"))).toEqual([]);

    expect(__decisionPackInternals.whyThisHelpsFor("cleanup_first", "owner/repo", undefined, { directPrShare: 0.01 } as any)[0]).toMatch(/cleaning up/);
    expect(__decisionPackInternals.whyThisHelpsFor("maintainer_lane", "owner/repo", undefined, { directPrShare: 0.01 } as any)[0]).toMatch(/maintainer-owned/);
    expect(__decisionPackInternals.whyThisHelpsFor("pursue", "owner/repo", undefined, { directPrShare: 0.01234 } as any)[0]).toMatch(/0.0123/);
    expect(__decisionPackInternals.whyThisHelpsFor("watch", "owner/repo", undefined, { directPrShare: 0.01 } as any)[0]).toMatch(/issue-discovery/);
    expect(__decisionPackInternals.whyThisHelpsFor("avoid_for_now", "owner/repo", undefined, { directPrShare: 0.01 } as any)[0]).toMatch(/low/);

    expect(__decisionPackInternals.nextActionsFor("cleanup_first", "direct_pr")[0]).toMatch(/Close/);
    expect(__decisionPackInternals.nextActionsFor("maintainer_lane", "direct_pr")[0]).toMatch(/intake/);
    expect(__decisionPackInternals.nextActionsFor("pursue", "direct_pr")[0]).toMatch(/narrow/);
    expect(__decisionPackInternals.nextActionsFor("watch", "issue_discovery")[0]).toMatch(/high-confidence/);
    expect(__decisionPackInternals.nextActionsFor("avoid_for_now", "inactive")[0]).toMatch(/different repo/);

    expect(__decisionPackInternals.priorityFor("pursue", { directPrShare: 0.02, issueDiscoveryShare: 0, emissionShare: 0.02 } as any, moderateOutcome, { openPullRequests: 2 } as any, [])).toBeGreaterThan(0);
    expect(__decisionPackInternals.priorityFor("avoid_for_now", { directPrShare: 0, issueDiscoveryShare: 0, emissionShare: 0 } as any, pressureOutcome, { openPullRequests: 500 } as any, [{ severity: "critical" } as any])).toBe(0);
    expect(
      __decisionPackInternals.buildRepoDecision({
        repo: repo("owner/direct", 0.03, 0),
        roleContext: outsideRole,
        outcome: moderateOutcome,
        totals: { openPullRequestsTotal: 30, openIssuesTotal: 150, mergedPullRequestsTotal: 10, closedUnmergedPullRequestsTotal: 4 } as any,
      }).riskReasons,
    ).toEqual(expect.arrayContaining([expect.stringContaining("busy"), expect.stringContaining("large"), expect.stringContaining("open PR")]));
    expect(
      __decisionPackInternals.buildRepoDecision({
        repo: repo("owner/issues", 0.02, 1),
        roleContext: outsideRole,
        outcome: undefined,
        syncState: { openPullRequestsCount: 1, openIssuesCount: 2, recentMergedPullRequestsCount: 3 } as any,
      }),
    ).toMatchObject({ recommendation: "watch", queue: { openPullRequests: 1, openIssues: 2, mergedPullRequests: 3 }, rewardUpside: { issueDiscoveryShare: 0.02 } });
    expect(
      __decisionPackInternals.buildRepoDecision({
        repo: repo("owner/inactive", 0, 0),
        roleContext: outsideRole,
        outcome: undefined,
      }),
    ).toMatchObject({ recommendation: "avoid_for_now", scoreBlockers: [expect.objectContaining({ code: "inactive_or_unknown_lane" })] });
    expect(__decisionPackInternals.severityRank("critical")).toBe(3);
    expect(__decisionPackInternals.severityRank("warning")).toBe(2);
    expect(__decisionPackInternals.severityRank("info")).toBe(1);
    expect(__decisionPackInternals.clamp(10, 0, 5)).toBe(5);
    expect(__decisionPackInternals.round(1.23456)).toBe(1.2346);
  });

  it("redacts official hotkeys, loads stale snapshots, and resolves repo decisions case-insensitively", async () => {
    const env = createTestEnv();
    const pack = {
      status: "ready",
      source: "computed",
      login: "jsonbored",
      generatedAt: "2026-05-24T00:00:00.000Z",
      stale: false,
      scoringModelSnapshotId: "scoring-1",
      profile: { login: "jsonbored", github: {}, source: {}, officialStats: null, registeredRepoActivity: {}, trustSignals: {} },
      outcomeHistory: { login: "jsonbored", generatedAt: "2026-05-24T00:00:00.000Z", totals: {}, repoOutcomes: [] },
      roleContexts: [],
      repoDecisions: [{ repoFullName: "JSONbored/awesome-claude", recommendation: "maintainer_lane" }],
      topActions: [],
      cleanupFirst: [],
      pursueRepos: [],
      avoidRepos: [],
      maintainerLaneRepos: [],
      scoreBlockers: [],
      dataQuality: { signalFidelity: { status: "complete" } },
      summary: "fixture",
      nextActions: [],
    } as unknown as ContributorDecisionPack;

    await persistSignalSnapshot(env, {
      id: "decision-pack-1",
      signalType: "contributor-decision-pack",
      targetKey: "jsonbored",
      payload: pack as unknown as Record<string, never>,
      generatedAt: "2026-05-24T00:00:00.000Z",
    });

    const loaded = await loadContributorDecisionPack(env, "jsonbored");
    expect(loaded).toMatchObject({ source: "snapshot", snapshotAgeSeconds: expect.any(Number), stale: expect.any(Boolean) });
    expect(repoDecisionFromPack(loaded!, "jsonbored/AWESOME-CLAUDE")).toMatchObject({ recommendation: "maintainer_lane" });
    expect(repoDecisionFromPack(loaded!, "missing/repo")).toBeNull();
    await expect(loadFreshContributorDecisionPack(env, "jsonbored", 1)).resolves.toBeNull();
    await expect(loadFreshContributorDecisionPack(env, "missing", 1)).resolves.toBeNull();

    expect(__decisionPackInternals.sanitizeOfficialStats({ gittensor: null } as any)).toBeNull();
    expect(__decisionPackInternals.sanitizeOfficialStats({ gittensor: { hotkey: "secret", totalMergedPrs: 5 } } as any)).toEqual({ totalMergedPrs: 5 });
    expect(
      __decisionPackInternals.authoritativeContributorRepoStats(
        {
          githubUsername: "JsonBored",
          repositories: [
            {
              repoFullName: "official/repo",
              pullRequests: 2,
              mergedPullRequests: 1,
              openPullRequests: 1,
              openIssues: 0,
              closedIssues: 0,
            },
          ],
        } as any,
        [{ repoFullName: "cached/repo" }] as any,
      ),
    ).toEqual([expect.objectContaining({ login: "jsonbored", repoFullName: "official/repo" })]);
    expect(__decisionPackInternals.authoritativeContributorRepoStats(null as any, [{ repoFullName: "cached/repo" }] as any)).toEqual([{ repoFullName: "cached/repo" }]);
    expect(
      __decisionPackInternals.withSnapshotMetadata({
        id: "snapshot-with-payload-date",
        signalType: "contributor-decision-pack",
        targetKey: "jsonbored",
        generatedAt: null,
        payload: { ...pack, generatedAt: "2026-05-25T00:00:00.000Z" } as any,
      }),
    ).toMatchObject({ generatedAt: "2026-05-25T00:00:00.000Z", source: "snapshot" });
    expect(__decisionPackInternals.snapshotAgeMs("not-a-date")).toBe(Number.POSITIVE_INFINITY);
  });

  it("builds a snapshot-style decision pack with maintainer, cleanup, pursue, watch, and avoid lanes", () => {
    const profile = {
      login: "jsonbored",
      generatedAt: "2026-05-25T00:00:00.000Z",
      github: {},
      source: {},
      gittensor: null,
      registeredRepoActivity: { reposTouched: ["owner/cleanup", "owner/pursue", "owner/issues"] },
      trustSignals: {},
    } as any;
    const outcomeHistory = {
      login: "jsonbored",
      generatedAt: "2026-05-25T00:00:00.000Z",
      source: {},
      totals: {},
      repoOutcomes: [
        { repoFullName: "owner/cleanup", role: "outside_contributor", lane: "direct_pr", maintainerLane: false, openPullRequests: 6, closedPullRequestRate: 0.4, credibility: 0.5, mergedPullRequests: 1, closedPullRequests: 2, validSolvedIssues: 0 },
        { repoFullName: "owner/pursue", role: "outside_contributor", lane: "split", maintainerLane: false, openPullRequests: 0, closedPullRequestRate: 0, credibility: 1, mergedPullRequests: 3, closedPullRequests: 0, validSolvedIssues: 1 },
      ],
      successPatterns: [],
      failurePatterns: [],
      summary: "fixture",
    } as any;

    const pack = __decisionPackInternals.buildContributorDecisionPack({
      login: "jsonbored",
      profile,
      outcomeHistory,
      repositories: [
        repo("jsonbored/owned", 0.02, 0),
        repo("owner/cleanup", 0.03, 0),
        repo("owner/pursue", 0.04, 0.5),
        repo("owner/issues", 0.01, 1),
        repo("owner/inactive", 0, 0),
        { ...repo("owner/unconfigured", 0.01, 0), registryConfig: null },
        { ...repo("owner/unregistered", 0.01, 0), isRegistered: false },
      ],
      syncStates: [
        { repoFullName: "owner/cleanup", status: "complete", openPullRequestsCount: 30, openIssuesCount: 150, recentMergedPullRequestsCount: 5, warnings: [], lastCompletedAt: "2026-05-25T00:00:00.000Z" },
        { repoFullName: "owner/inactive", status: "complete", openPullRequestsCount: 0, openIssuesCount: 0, recentMergedPullRequestsCount: 0, warnings: [], lastCompletedAt: "2026-05-25T00:00:00.000Z" },
      ] as any,
      syncSegments: [],
      totals: [{ repoFullName: "owner/pursue", openPullRequestsTotal: 2, openIssuesTotal: 3, mergedPullRequestsTotal: 4, closedUnmergedPullRequestsTotal: 1 }] as any,
      scoringModelSnapshotId: "scoring-1",
      contributorPullRequests: [{ repoFullName: "owner/cleanup", authorLogin: "jsonbored", authorAssociation: "CONTRIBUTOR" }] as any,
      contributorIssues: [],
    });

    expect(pack.repoDecisions).toHaveLength(6);
    expect(pack.maintainerLaneRepos.map((decision) => decision.repoFullName)).toContain("jsonbored/owned");
    expect(pack.cleanupFirst.map((decision) => decision.repoFullName)).toContain("owner/cleanup");
    expect(pack.pursueRepos.map((decision) => decision.repoFullName)).toContain("owner/pursue");
    expect(pack.avoidRepos.map((decision) => decision.repoFullName)).toEqual(expect.arrayContaining(["owner/inactive", "owner/unconfigured"]));
    expect(pack.topActions.map((action) => action.actionKind)).toEqual(expect.arrayContaining(["maintainer_lane_improve_repo", "cleanup_existing_prs", "open_new_direct_pr", "file_issue_discovery"]));
    expect(pack.roleContexts.map((role) => role.repoFullName)).not.toContain("owner/unconfigured");
    expect(pack.nextActions.length).toBeGreaterThan(0);
  });
});

function repo(fullName: string, emissionShare: number, issueDiscoveryShare: number) {
  const [owner, name] = fullName.split("/");
  return {
    fullName,
    owner,
    name,
    isInstalled: false,
    isRegistered: true,
    isPrivate: false,
    registryConfig: {
      repo: fullName,
      emissionShare,
      issueDiscoveryShare,
      maintainerCut: 0,
      labelMultipliers: {},
      raw: {},
    },
  } as any;
}
