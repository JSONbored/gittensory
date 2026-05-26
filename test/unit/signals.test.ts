import { describe, expect, it } from "vitest";
import {
  buildBountyAdvisory,
  buildCollisionReport,
  buildConfigQuality,
  buildContributorOpportunities,
  buildContributorFit,
  buildContributorProfile,
  buildContributorScoringProfile,
  buildLabelAudit,
  buildLaneAdvice,
  buildPreflightResult,
  buildPublicPrIntelligenceComment,
  buildQueueHealth,
  detectGittensorContributor,
  shouldPublishPrIntelligenceComment,
} from "../../src/signals/engine";
import type { BountyRecord, ContributorRepoStatRecord, IssueRecord, PullRequestRecord, RepositoryRecord, RepositorySettings, ScoringModelSnapshotRecord } from "../../src/types";

const repo: RepositoryRecord = {
  fullName: "entrius/allways-ui",
  owner: "entrius",
  name: "allways-ui",
  isInstalled: true,
  isRegistered: true,
  isPrivate: false,
  registryConfig: {
    repo: "entrius/allways-ui",
    emissionShare: 0.01107,
    issueDiscoveryShare: 0,
    labelMultipliers: { bug: 1.1, enhancement: 1, feature: 1.25, refactor: 0.5 },
    trustedLabelPipeline: true,
    maintainerCut: 0,
    raw: {},
  },
};

const issues: IssueRecord[] = [
  {
    repoFullName: repo.fullName,
    number: 7,
    title: "Dashboard cache refresh fails after reconnect",
    state: "open",
    authorLogin: "reporter",
    labels: ["bug"],
    linkedPrs: [],
  },
  {
    repoFullName: repo.fullName,
    number: 8,
    title: "Add reconnect regression coverage",
    state: "open",
    authorLogin: "reporter",
    labels: ["feature"],
    linkedPrs: [],
  },
];

const pullRequests: PullRequestRecord[] = [
  {
    repoFullName: repo.fullName,
    number: 12,
    title: "Fix dashboard cache refresh after reconnect",
    state: "open",
    authorLogin: "oktofeesh1",
    authorAssociation: "NONE",
    labels: ["bug"],
    linkedIssues: [7],
    updatedAt: "2026-04-01T00:00:00.000Z",
  },
  {
    repoFullName: repo.fullName,
    number: 13,
    title: "Alternative cache reconnect fix",
    state: "open",
    authorLogin: "other",
    authorAssociation: "NONE",
    labels: ["bug"],
    linkedIssues: [7],
  },
];

describe("world-class backend signals", () => {
  it("classifies direct PR lanes from registry configuration", () => {
    const lane = buildLaneAdvice(repo, repo.fullName);
    expect(lane.lane).toBe("direct_pr");
    expect(lane.contributorGuidance).toMatch(/focused PRs/i);
  });

  it("detects duplicate and WIP collision clusters", () => {
    const report = buildCollisionReport(repo.fullName, issues, pullRequests);
    expect(report.summary.highRiskCount).toBeGreaterThan(0);
    expect(report.clusters[0]?.items.map((item) => item.number)).toContain(7);
  });

  it("builds maintainer burden from queue hygiene signals", () => {
    const collisions = buildCollisionReport(repo.fullName, issues, pullRequests);
    const health = buildQueueHealth(repo, issues, pullRequests, collisions);
    expect(health.signals.openPullRequests).toBe(2);
    expect(health.findings.map((finding) => finding.code)).toContain("collision_clusters");
  });

  it("audits configured labels against local observed label usage", () => {
    const quality = buildConfigQuality(repo, issues, pullRequests, repo.fullName);
    expect(quality.notObservedConfiguredLabels).toContain("refactor");
    expect(quality.findings.map((finding) => finding.code)).toContain("configured_labels_not_observed");
  });

  it("profiles contributors and ranks evidence-backed opportunities", () => {
    const profile = buildContributorProfile(
      "oktofeesh1",
      { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" },
      pullRequests,
      [],
    );
    const opportunities = buildContributorOpportunities(profile, [repo], issues, pullRequests);
    expect(profile.trustSignals.level).toBe("new");
    expect(opportunities[0]?.repoFullName).toBe(repo.fullName);
  });

  it("profiles contributors from cached repo stats when sampled PR rows miss their history", () => {
    const repoStats: ContributorRepoStatRecord[] = [
      {
        login: "JSONbored",
        repoFullName: "JSONbored/awesome-claude",
        pullRequests: 49,
        mergedPullRequests: 47,
        openPullRequests: 1,
        issues: 12,
        stalePullRequests: 0,
        unlinkedPullRequests: 1,
        dominantLabels: ["bug", "ci"],
        lastActivityAt: "2026-05-25T00:00:00.000Z",
      },
    ];
    const profile = buildContributorProfile("jsonbored", { login: "JSONbored", topLanguages: ["TypeScript"], source: "github" }, [], [], repoStats);
    const detection = detectGittensorContributor("jsonbored", { ...pullRequests[0]!, authorLogin: "JSONbored" }, [], [], repoStats);

    expect(profile.registeredRepoActivity).toMatchObject({
      pullRequests: 49,
      mergedPullRequests: 47,
      issues: 12,
      reposTouched: ["JSONbored/awesome-claude"],
    });
    expect(profile.trustSignals.level).toBe("established");
    expect(detection).toMatchObject({ detected: true, priorMergedPullRequests: 47, priorIssues: 12 });
  });

  it("prefers Gittensor API contributor totals over broad GitHub cache history", () => {
    const profile = buildContributorProfile(
      "jsonbored",
      { login: "JSONbored", topLanguages: ["Ruby", "Python"], source: "github" },
      [],
      [],
      [
        {
          login: "jsonbored",
          repoFullName: "JSONbored/awesome-claude",
          pullRequests: 183,
          mergedPullRequests: 164,
          openPullRequests: 1,
          issues: 86,
          stalePullRequests: 0,
          unlinkedPullRequests: 0,
          dominantLabels: ["feature"],
        },
      ],
      {
        source: "gittensor_api",
        githubId: "49853598",
        githubUsername: "JSONbored",
        uid: 29,
        hotkey: "hotkey",
        isEligible: true,
        credibility: 1,
        eligibleRepoCount: 1,
        issueDiscoveryScore: 0,
        issueTokenScore: 0,
        issueCredibility: 1,
        isIssueEligible: false,
        issueEligibleRepoCount: 0,
        alphaPerDay: 72,
        taoPerDay: 0.3,
        usdPerDay: 92,
        totals: {
          pullRequests: 63,
          mergedPullRequests: 46,
          openPullRequests: 9,
          closedPullRequests: 8,
          openIssues: 44,
          closedIssues: 4,
          solvedIssues: 1,
          validSolvedIssues: 1,
        },
        repositories: [
          {
            repoFullName: "we-promise/sure",
            pullRequests: 47,
            mergedPullRequests: 37,
            openPullRequests: 6,
            closedPullRequests: 4,
            openIssues: 0,
            closedIssues: 0,
            solvedIssues: 0,
            validSolvedIssues: 0,
            isEligible: true,
            isIssueEligible: false,
            credibility: 0.9,
            issueCredibility: 0,
            totalScore: 43,
            baseTotalScore: 549,
          },
          {
            repoFullName: "jsonbored/awesome-claude",
            pullRequests: 0,
            mergedPullRequests: 0,
            openPullRequests: 0,
            closedPullRequests: 0,
            openIssues: 42,
            closedIssues: 0,
            solvedIssues: 0,
            validSolvedIssues: 0,
            isEligible: false,
            isIssueEligible: false,
            credibility: 0,
            issueCredibility: 0,
            totalScore: 0,
            baseTotalScore: 0,
          },
        ],
        pullRequests: [{ repoFullName: "we-promise/sure", number: 1869, title: "feat(imports): verify Sure NDJSON import readback", state: "MERGED", label: null, score: 13.55, baseScore: 16.73, tokenScore: 128.47 }],
        issueLabels: ["feature", "help wanted"],
      },
    );

    expect(profile.source).toBe("gittensor_api");
    expect(profile.registeredRepoActivity).toMatchObject({ pullRequests: 63, mergedPullRequests: 46, issues: 48 });
    expect(profile.gittensor?.githubId).toBe("49853598");

    const fit = buildContributorFit(profile, [], [], [], [], [
      {
        login: "jsonbored",
        repoFullName: "gittensor/api-official",
        pullRequests: 63,
        mergedPullRequests: 46,
        openPullRequests: 9,
        issues: 48,
        stalePullRequests: 0,
        unlinkedPullRequests: 0,
        dominantLabels: [],
      },
    ]);
    const scoring = buildContributorScoringProfile({ login: "jsonbored", fit, scoringSnapshot: scoringModelSnapshot() });

    expect(fit.summary).toContain("Gittensor API registered-repo PR");
    expect(scoring.evidence).toMatchObject({
      registeredRepoPullRequests: 63,
      mergedPullRequests: 46,
      openPullRequests: 9,
      issueDiscoveryReports: 1,
    });
    expect(scoring.privateSignals.join("\n")).toContain("Gittensor API");
  });

  it("preflights planned PRs without reward language", () => {
    const result = buildPreflightResult(
      {
        repoFullName: repo.fullName,
        title: "Fix dashboard cache refresh after reconnect",
        body: "Fixes #7",
        changedFiles: ["src/cache.ts"],
      },
      repo,
      issues,
      pullRequests,
    );
    expect(result.status).toBe("needs_work");
    expect(JSON.stringify(result)).not.toMatch(/reward|farming/i);
    expect(result.findings.map((finding) => finding.code)).toContain("missing_test_evidence");
  });

  it("gates public comments to detected contributors and sanitizes comment text", () => {
    const currentPr = pullRequests[0]!;
    const priorPr: PullRequestRecord = {
      ...currentPr,
      number: 3,
      state: "closed",
      mergedAt: "2026-05-01T00:00:00.000Z",
    };
    const detection = { ...detectGittensorContributor("oktofeesh1", currentPr, [currentPr, priorPr], []), source: "official_gittensor_api" as const };
    const settings = {
      repoFullName: repo.fullName,
      commentMode: "detected_contributors_only" as const,
      publicSignalLevel: "standard" as const,
      checkRunMode: "off" as const,
      checkRunDetailLevel: "minimal" as const,
      autoLabelEnabled: true,
      gittensorLabel: "gittensor",
      createMissingLabel: true,
      publicSurface: "comment_and_label" as const,
      includeMaintainerAuthors: false,
      requireLinkedIssue: false,
      backfillEnabled: true,
      privateTrustEnabled: true,
    };
    const collisions = buildCollisionReport(repo.fullName, issues, pullRequests);
    const queueHealth = buildQueueHealth(repo, issues, pullRequests, collisions);
    const preflight = buildPreflightResult(
      { repoFullName: repo.fullName, title: currentPr.title, body: "Fixes #7", linkedIssues: [7] },
      repo,
      issues,
      pullRequests,
    );
    const profile = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, [
      currentPr,
      priorPr,
    ], []);
    const comment = buildPublicPrIntelligenceComment({ repo, pr: currentPr, profile, detection, queueHealth, collisions, preflight, settings });

    expect(detection.detected).toBe(true);
    expect(shouldPublishPrIntelligenceComment(settings, detection)).toBe(true);
    expect(comment).toContain("<!-- gittensory-pr-intelligence -->");
    expect(comment).not.toMatch(/wallet|raw trust score|ranking|farming|reward/i);
  });

  it("classifies every participation lane boundary", () => {
    const inactive = buildLaneAdvice({ ...repo, registryConfig: { ...repo.registryConfig!, emissionShare: 0 } }, repo.fullName);
    const issueDiscovery = buildLaneAdvice({ ...repo, registryConfig: { ...repo.registryConfig!, issueDiscoveryShare: 1 } }, repo.fullName);
    const split = buildLaneAdvice({ ...repo, registryConfig: { ...repo.registryConfig!, issueDiscoveryShare: 0.4 } }, repo.fullName);
    const unknown = buildLaneAdvice(null, "unknown/repo");

    expect(inactive.lane).toBe("inactive");
    expect(issueDiscovery.lane).toBe("issue_discovery");
    expect(split.lane).toBe("split");
    expect(unknown.lane).toBe("unknown");
  });

  it("keeps config quality useful for fragile and inactive repos", () => {
    const unknownQuality = buildConfigQuality(null, [], [], "unknown/repo");
    const inactiveQuality = buildConfigQuality({ ...repo, registryConfig: { ...repo.registryConfig!, emissionShare: 0 } }, [], [], repo.fullName);
    const noMultiplierQuality = buildConfigQuality({ ...repo, registryConfig: { ...repo.registryConfig!, labelMultipliers: {} } }, [], [], repo.fullName);

    expect(unknownQuality.level).toBe("needs_attention");
    expect(inactiveQuality.findings.map((finding) => finding.code)).toContain("inactive_allocation");
    expect(noMultiplierQuality.findings.map((finding) => finding.code)).toContain("trusted_labels_without_multipliers");
  });

  it("keeps contributor detection and comment modes conservative", () => {
    const currentPr = pullRequests[0]!;
    const settings: RepositorySettings = {
      repoFullName: repo.fullName,
      commentMode: "off",
      publicSignalLevel: "minimal",
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      autoLabelEnabled: true,
      gittensorLabel: "gittensor",
      createMissingLabel: true,
      publicSurface: "comment_and_label",
      includeMaintainerAuthors: false,
      requireLinkedIssue: false,
      backfillEnabled: true,
      privateTrustEnabled: true,
    };
    const undetected = detectGittensorContributor("newbie", currentPr, [currentPr], []);
    const cachedDetected = detectGittensorContributor("oktofeesh1", currentPr, [currentPr, { ...currentPr, number: 10, mergedAt: "2026-05-01T00:00:00.000Z" }], []);

    expect(undetected.detected).toBe(false);
    expect(shouldPublishPrIntelligenceComment(settings, undetected)).toBe(false);
    expect(shouldPublishPrIntelligenceComment({ ...settings, commentMode: "all_prs" }, undetected)).toBe(false);
    expect(shouldPublishPrIntelligenceComment({ ...settings, commentMode: "all_prs" }, cachedDetected)).toBe(false);
    expect(shouldPublishPrIntelligenceComment({ ...settings, commentMode: "all_prs" }, { ...cachedDetected, source: "official_gittensor_api" })).toBe(true);
  });

  it("returns hold/caution opportunities for inactive and issue-discovery lanes", () => {
    const profile = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, pullRequests, issues);
    const inactiveRepo: RepositoryRecord = {
      ...repo,
      fullName: "owner/inactive",
      registryConfig: { ...repo.registryConfig!, repo: "owner/inactive", emissionShare: 0 },
    };
    const issueDiscoveryRepo: RepositoryRecord = {
      ...repo,
      fullName: "owner/issues-only",
      registryConfig: { ...repo.registryConfig!, repo: "owner/issues-only", issueDiscoveryShare: 1 },
    };
    const issueForInactive: IssueRecord = { ...issues[0]!, repoFullName: inactiveRepo.fullName, number: 70, title: "Inactive issue" };
    const issueForDiscovery: IssueRecord = { ...issues[1]!, repoFullName: issueDiscoveryRepo.fullName, number: 71, title: "Discovery issue" };

    const opportunities = buildContributorOpportunities(profile, [inactiveRepo, issueDiscoveryRepo], [issueForInactive, issueForDiscovery], []);

    expect(opportunities.find((opportunity) => opportunity.repoFullName === inactiveRepo.fullName)?.fit).toBe("hold");
    expect(opportunities.find((opportunity) => opportunity.repoFullName === issueDiscoveryRepo.fullName)?.warnings).toContain("This repo is not a direct-PR-first lane.");
  });

  it("summarizes public comments at minimal signal level", () => {
    const currentPr: PullRequestRecord = { ...pullRequests[0]!, linkedIssues: [], body: "" };
    const detection = { ...detectGittensorContributor("newbie", currentPr, [], []), detected: true, source: "official_gittensor_api" as const, reason: "Official Gittensor API confirms this GitHub user." };
    const collisions = buildCollisionReport(repo.fullName, issues, [currentPr]);
    const queueHealth = buildQueueHealth(repo, issues, [currentPr], collisions);
    const preflight = buildPreflightResult({ repoFullName: repo.fullName, title: currentPr.title, changedFiles: ["README.md"] }, repo, issues, [currentPr]);
    const profile = buildContributorProfile("newbie", { login: "newbie", topLanguages: [], source: "unavailable" }, [], []);
    const settings: RepositorySettings = {
      repoFullName: repo.fullName,
      commentMode: "all_prs",
      publicSignalLevel: "minimal",
      checkRunMode: "off",
      checkRunDetailLevel: "minimal",
      autoLabelEnabled: true,
      gittensorLabel: "gittensor",
      createMissingLabel: true,
      publicSurface: "comment_and_label",
      includeMaintainerAuthors: false,
      requireLinkedIssue: false,
      backfillEnabled: true,
      privateTrustEnabled: true,
    };

    const comment = buildPublicPrIntelligenceComment({ repo, pr: currentPr, profile, detection, queueHealth, collisions, preflight, settings });

    expect(comment).toContain("Linked issues: Not required by this repo setting");
    expect(comment).toContain("Public profile languages: not available");
    expect(comment).not.toMatch(/trust score|wallet|ranking/i);
  });

  it("separates active and historical bounty lifecycle risk", () => {
    const active: BountyRecord = {
      id: "bounty-1",
      repoFullName: repo.fullName,
      issueNumber: 7,
      status: "Active",
      amountText: "1.0",
      payload: { bounty_amount: 1 },
    };
    const historical: BountyRecord = {
      ...active,
      id: "bounty-2",
      status: "Completed",
      payload: { target_bounty: 2, bounty_amount: 0 },
    };
    const linkedIssue: IssueRecord = { ...issues[0]!, linkedPrs: [12, 13] };

    expect(buildBountyAdvisory(active, repo, null)).toMatchObject({ lifecycle: "active", fundingStatus: "funded", consensusRisk: "high" });
    expect(buildBountyAdvisory(historical, null, linkedIssue)).toMatchObject({ lifecycle: "historical", fundingStatus: "target_only", consensusRisk: "medium" });
  });

  it("covers contributor fit and label audit warning boundaries", () => {
    const noUsageAudit = buildLabelAudit(
      { ...repo, registryConfig: { ...repo.registryConfig!, labelMultipliers: { feature: 1 } } },
      [],
      [],
      [],
      repo.fullName,
    );
    expect(noUsageAudit.findings.map((finding) => finding.code)).toContain("configured_labels_unused");

    const mergedPullRequests = Array.from({ length: 4 }, (_, index): PullRequestRecord => ({
      ...pullRequests[0]!,
      number: 200 + index,
      state: "merged",
      mergedAt: "2026-05-01T00:00:00.000Z",
    }));
    const established = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["Rust"], source: "github" }, mergedPullRequests, []);
    const busyPullRequests = Array.from({ length: 8 }, (_, index): PullRequestRecord => ({
      ...pullRequests[0]!,
      number: 300 + index,
      repoFullName: "owner/split",
      linkedIssues: [index + 1],
    }));
    const splitRepo: RepositoryRecord = {
      ...repo,
      fullName: "owner/split",
      registryConfig: { ...repo.registryConfig!, repo: "owner/split", issueDiscoveryShare: 0.5 },
    };
    const splitIssues = [{ ...issues[0]!, repoFullName: "owner/split", number: 100, labels: ["bug"] }];
    const fit = buildContributorFit(
      established,
      [splitRepo],
      splitIssues,
      busyPullRequests,
      [{ repoFullName: "owner/split", status: "success", sourceKind: "github", primaryLanguage: "TypeScript", openIssuesCount: 1, openPullRequestsCount: 8, recentMergedPullRequestsCount: 0, warnings: [] }],
      [],
    );

    expect(established.trustSignals.level).toBe("established");
    expect(fit.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["no_language_fit", "busy_queue_matches"]));
    expect(fit.opportunities[0]?.warnings).toContain("This repo has a busy open PR queue.");
  });

  it("detects prior non-merged activity as contributor context", () => {
    const currentPr = pullRequests[0]!;
    const priorOpenPr: PullRequestRecord = { ...currentPr, number: 99, mergedAt: undefined };
    const detection = detectGittensorContributor("oktofeesh1", currentPr, [currentPr, priorOpenPr], []);

    expect(detection).toMatchObject({ detected: true, priorPullRequests: 1, priorMergedPullRequests: 0 });
  });
});

function scoringModelSnapshot(): ScoringModelSnapshotRecord {
  return {
    id: "scoring-fixture",
    sourceKind: "test",
    sourceUrl: "fixture://scoring",
    fetchedAt: "2026-05-25T00:00:00.000Z",
    activeModel: "current_density_model",
    constants: {},
    programmingLanguages: {},
    warnings: [],
    payload: {},
  };
}
