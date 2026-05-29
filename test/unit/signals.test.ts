import { describe, expect, it } from "vitest";
import {
  buildBountyAdvisory,
  buildIssueQualityReport,
  classifyBountyLifecycle,
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

    expect(buildBountyAdvisory(active, repo, null)).toMatchObject({ lifecycle: "active", isActiveOpportunity: true, fundingStatus: "funded", consensusRisk: "high" });
    expect(buildBountyAdvisory(historical, null, linkedIssue)).toMatchObject({ lifecycle: "completed", isActiveOpportunity: false, fundingStatus: "target_only", consensusRisk: "medium" });
  });

  it("classifies the full bounty lifecycle: active, historical, completed, cancelled, stale, ambiguous", () => {
    const base = { repoFullName: repo.fullName, issueNumber: 7, payload: { bounty_amount: "1.0000" } };
    const openIssue: IssueRecord = { ...issues[0]!, state: "open", linkedPrs: [] };
    const closedIssue: IssueRecord = { ...issues[0]!, state: "closed", linkedPrs: [] };

    const active: BountyRecord = { ...base, id: "active", status: "Open", updatedAt: new Date().toISOString() };
    const historical: BountyRecord = { ...base, id: "historical", status: "Archived" };
    const completed: BountyRecord = { ...base, id: "completed", status: "Paid out" };
    const cancelled: BountyRecord = { ...base, id: "cancelled", status: "Withdrawn" };
    const stale: BountyRecord = { ...base, id: "stale", status: "Active", updatedAt: "2020-01-01T00:00:00.000Z" };
    const ambiguousStatus: BountyRecord = { ...base, id: "ambiguous-status", status: "Pending triage" };

    expect(classifyBountyLifecycle(active, openIssue)).toBe("active");
    expect(classifyBountyLifecycle(historical, openIssue)).toBe("historical");
    expect(classifyBountyLifecycle(completed, openIssue)).toBe("completed");
    expect(classifyBountyLifecycle(cancelled, openIssue)).toBe("cancelled");
    expect(classifyBountyLifecycle(stale, openIssue)).toBe("stale");
    expect(classifyBountyLifecycle(ambiguousStatus, openIssue)).toBe("ambiguous");
    // An active-looking bounty on a closed issue is a conflicting signal, not a live opportunity.
    expect(classifyBountyLifecycle(active, closedIssue)).toBe("ambiguous");

    expect(buildBountyAdvisory(historical, repo, openIssue).findings.map((finding) => finding.code)).toContain("historical_bounty");
    expect(buildBountyAdvisory(completed, repo, openIssue).findings.map((finding) => finding.code)).toContain("completed_bounty");
    expect(buildBountyAdvisory(cancelled, repo, openIssue).findings.map((finding) => finding.code)).toContain("cancelled_bounty");
    expect(buildBountyAdvisory(stale, repo, openIssue).findings.map((finding) => finding.code)).toContain("stale_bounty");
    expect(buildBountyAdvisory(ambiguousStatus, repo, openIssue).findings.map((finding) => finding.code)).toContain("ambiguous_bounty");
    expect(buildBountyAdvisory(stale, repo, openIssue).isActiveOpportunity).toBe(false);
    expect(buildBountyAdvisory({ ...base, id: "target-only", status: "Open", payload: { target_bounty: 1, bounty_amount: "0.0000" } }, repo, openIssue).fundingStatus).toBe("target_only");
    expect(buildBountyAdvisory({ ...base, id: "unknown-funding", status: "Open", payload: {} }, repo, openIssue).fundingStatus).toBe("unknown");

    const stalePreflight = buildPreflightResult({ repoFullName: repo.fullName, title: "Fix cache", body: "Fixes #7" }, repo, [openIssue], [], [stale]);
    const ambiguousPreflight = buildPreflightResult({ repoFullName: repo.fullName, title: "Fix cache", body: "Fixes #7" }, repo, [openIssue], [], [ambiguousStatus]);
    expect(stalePreflight.findings.map((finding) => finding.code)).toContain("linked_issue_bounty_unverified");
    expect(ambiguousPreflight.findings.map((finding) => finding.code)).toContain("linked_issue_bounty_unverified");
  });

  it("includes linked PR validity when PR records are available", () => {
    const issueWithPrs: IssueRecord = { ...issues[0]!, number: 7, state: "open", linkedPrs: [12, 99] };
    const fundedActive: BountyRecord = { id: "linked", repoFullName: repo.fullName, issueNumber: 7, status: "Open", payload: { bounty_amount: "2.0000" }, updatedAt: new Date().toISOString() };

    const advisory = buildBountyAdvisory(fundedActive, repo, issueWithPrs, pullRequests);
    expect(advisory.linkedPrs).toEqual([
      { number: 12, state: "open", isActive: true },
      { number: 13, state: "open", isActive: true },
      { number: 99, state: "unknown", isActive: false },
    ]);
    expect(advisory.findings.map((finding) => finding.code)).toContain("bounty_has_active_pr");
  });

  it("feeds bounty state into issue quality scoring", () => {
    const completedBounty: BountyRecord = { id: "q1", repoFullName: repo.fullName, issueNumber: 7, status: "Completed", payload: {} };
    const cancelledBounty: BountyRecord = { id: "q2", repoFullName: repo.fullName, issueNumber: 8, status: "Cancelled", payload: {} };
    const activeBounty: BountyRecord = { id: "q3", repoFullName: repo.fullName, issueNumber: 7, status: "Active", payload: {}, updatedAt: new Date().toISOString() };
    const report = buildIssueQualityReport(repo, issues, [], repo.fullName, [completedBounty, cancelledBounty]);
    const activeReport = buildIssueQualityReport(repo, issues, [], repo.fullName, [activeBounty]);
    const issue7 = report.issues.find((entry) => entry.number === 7)!;
    const issue8 = report.issues.find((entry) => entry.number === 8)!;
    expect(issue7.status).toBe("do_not_use");
    expect(issue8.status).toBe("do_not_use");
    expect(issue8.warnings.some((warning) => /cancelled bounty/i.test(warning))).toBe(true);
    expect(activeReport.issues.find((entry) => entry.number === 7)?.reasons).toContain("Active bounty context is attached (contribution context, not guaranteed payout).");
  });

  it("keeps stale and ambiguous bounties out of strong opportunity ranking", () => {
    const profile = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, pullRequests, []);
    const repoWithoutOpenPrs = { ...repo, fullName: "owner/bounty-fit", registryConfig: { ...repo.registryConfig!, repo: "owner/bounty-fit" } };
    const bountyIssues: IssueRecord[] = [
      { ...issues[0]!, repoFullName: repoWithoutOpenPrs.fullName, number: 1, title: "Fresh funded task", linkedPrs: [] },
      { ...issues[0]!, repoFullName: repoWithoutOpenPrs.fullName, number: 2, title: "Stale funded task", linkedPrs: [] },
      { ...issues[0]!, repoFullName: repoWithoutOpenPrs.fullName, number: 3, title: "Completed funded task", linkedPrs: [] },
      { ...issues[0]!, repoFullName: repoWithoutOpenPrs.fullName, number: 4, title: "Ambiguous funded task", linkedPrs: [] },
    ];
    const bounties: BountyRecord[] = [
      { id: "active-fit", repoFullName: repoWithoutOpenPrs.fullName, issueNumber: 1, status: "Active", payload: { bounty_alpha: "1.0000" }, updatedAt: new Date().toISOString() },
      { id: "stale-fit", repoFullName: repoWithoutOpenPrs.fullName, issueNumber: 2, status: "Active", payload: { bounty_alpha: "1.0000" }, updatedAt: "2020-01-01T00:00:00.000Z" },
      { id: "completed-fit", repoFullName: repoWithoutOpenPrs.fullName, issueNumber: 3, status: "Completed", payload: { bounty_alpha: "1.0000" } },
      { id: "ambiguous-fit", repoFullName: repoWithoutOpenPrs.fullName, issueNumber: 4, status: "Pending triage", payload: { bounty_alpha: "1.0000" } },
    ];

    const opportunities = buildContributorOpportunities(profile, [repoWithoutOpenPrs], bountyIssues, [], bounties);

    expect(opportunities.map((opportunity) => opportunity.issueNumber)).toEqual([1, 2, 4]);
    expect(opportunities.find((opportunity) => opportunity.issueNumber === 1)?.reasons).toContain("An active bounty is attached as contribution context (not guaranteed payout).");
    expect(opportunities.find((opportunity) => opportunity.issueNumber === 2)?.fit).not.toBe("good");
    expect(opportunities.find((opportunity) => opportunity.issueNumber === 2)?.warnings).toContain("Attached bounty context looks stale; confirm it is still active before acting.");
    expect(opportunities.find((opportunity) => opportunity.issueNumber === 4)?.fit).not.toBe("good");
    expect(opportunities.find((opportunity) => opportunity.issueNumber === 4)?.warnings).toContain("Attached bounty state is ambiguous; verify it before acting.");

    const strongProfile = buildContributorProfile(
      "oktofeesh1",
      { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" },
      [],
      [],
      [
        {
          login: "oktofeesh1",
          repoFullName: repoWithoutOpenPrs.fullName,
          pullRequests: 4,
          mergedPullRequests: 3,
          openPullRequests: 0,
          issues: 1,
          stalePullRequests: 0,
          unlinkedPullRequests: 0,
          dominantLabels: ["bug", "feature", "enhancement", "refactor", "docs"],
        },
      ],
    );
    const highSignalStaleIssue: IssueRecord = { ...bountyIssues[1]!, labels: ["bug", "feature", "enhancement", "refactor", "docs"] };
    const highSignalStale = buildContributorOpportunities(strongProfile, [repoWithoutOpenPrs], [highSignalStaleIssue], [], [bounties[1]!]);
    expect(highSignalStale[0]).toMatchObject({ fit: "caution", score: 70 });
  });

  it("drops completed, cancelled, and historical bounty issues from opportunities entirely", () => {
    const profile = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, pullRequests, []);
    const deadRepo = { ...repo, fullName: "owner/dead-bounties", registryConfig: { ...repo.registryConfig!, repo: "owner/dead-bounties" } };
    const deadIssues: IssueRecord[] = [
      { ...issues[0]!, repoFullName: deadRepo.fullName, number: 1, title: "Completed work", linkedPrs: [] },
      { ...issues[0]!, repoFullName: deadRepo.fullName, number: 2, title: "Cancelled work", linkedPrs: [] },
      { ...issues[0]!, repoFullName: deadRepo.fullName, number: 3, title: "Historical work", linkedPrs: [] },
      { ...issues[0]!, repoFullName: deadRepo.fullName, number: 4, title: "Active work", linkedPrs: [] },
    ];
    const deadBounties: BountyRecord[] = [
      { id: "d1", repoFullName: deadRepo.fullName, issueNumber: 1, status: "Completed", payload: { bounty_alpha: "1.0000" } },
      { id: "d2", repoFullName: deadRepo.fullName, issueNumber: 2, status: "Cancelled", payload: { bounty_alpha: "1.0000" } },
      { id: "d3", repoFullName: deadRepo.fullName, issueNumber: 3, status: "Archived", payload: { bounty_alpha: "1.0000" } },
      { id: "d4", repoFullName: deadRepo.fullName, issueNumber: 4, status: "Active", payload: { bounty_alpha: "1.0000" }, updatedAt: new Date().toISOString() },
    ];
    const numbers = buildContributorOpportunities(profile, [deadRepo], deadIssues, [], deadBounties).map((opportunity) => opportunity.issueNumber);
    expect(numbers).not.toContain(1);
    expect(numbers).not.toContain(2);
    expect(numbers).not.toContain(3);
    expect(numbers).toContain(4);
  });

  it("keeps bounty-aware opportunity and issue-quality work bounded for large bounty/issue sets", () => {
    const profile = buildContributorProfile("oktofeesh1", { login: "oktofeesh1", topLanguages: ["TypeScript"], source: "github" }, pullRequests, []);
    // 10 registered repos x 600 issues each = 6000 issues, each with a bounty (even issues completed, odd active).
    const bigRepos = Array.from({ length: 10 }, (_, index) => ({
      ...repo,
      fullName: `owner/huge-${index}`,
      registryConfig: { ...repo.registryConfig!, repo: `owner/huge-${index}` },
    }));
    const bigIssues: IssueRecord[] = bigRepos.flatMap((bigRepo) =>
      Array.from({ length: 600 }, (_, index) => ({ ...issues[0]!, repoFullName: bigRepo.fullName, number: index + 1, title: `Issue ${index + 1}`, linkedPrs: [] })),
    );
    const bigBounties: BountyRecord[] = bigIssues.map((issue, index) => ({
      id: `big-${index}`,
      repoFullName: issue.repoFullName,
      issueNumber: issue.number,
      status: issue.number % 2 === 0 ? "Completed" : "Active",
      payload: { bounty_alpha: "1.0000" },
      updatedAt: new Date().toISOString(),
    }));

    const opportunities = buildContributorOpportunities(profile, bigRepos, bigIssues, [], bigBounties);
    // Output is bounded by the 25-opportunity cap even with thousands of candidates...
    expect(opportunities.length).toBeLessThanOrEqual(25);
    // ...and completed bounties (even issue numbers) are never surfaced as opportunities.
    expect(opportunities.every((opportunity) => (opportunity.issueNumber ?? 0) % 2 === 1)).toBe(true);

    const quality = buildIssueQualityReport(bigRepos[0]!, bigIssues.filter((issue) => issue.repoFullName === bigRepos[0]!.fullName), [], bigRepos[0]!.fullName, bigBounties);
    expect(quality.issues.length).toBeLessThanOrEqual(100);
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
