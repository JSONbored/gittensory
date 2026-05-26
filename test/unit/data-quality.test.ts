import { describe, expect, it } from "vitest";
import { buildCoreSignalFidelity, buildRepoDataQuality, buildSignalFidelity } from "../../src/signals/data-quality";
import type { PullRequestDetailSyncStateRecord, RepoGithubTotalsSnapshotRecord, RepoSyncSegmentRecord, RepoSyncStateRecord } from "../../src/types";

describe("sync data quality", () => {
  it("marks capped and partial segments as degraded instead of complete", () => {
    const state = repoState({ status: "capped", warnings: ["GitHub sync reached local cap of 100 item(s)."] });
    const quality = buildRepoDataQuality("owner/repo", state, [
      segment({ segment: "open_pull_requests", status: "capped", fetchedCount: 100, nextCursor: "2" }),
      segment({ segment: "labels", status: "complete", fetchedCount: 12 }),
    ]);

    expect(quality).toMatchObject({
      status: "degraded",
      capped: true,
      partial: true,
      cappedSegments: ["open_pull_requests"],
      warnings: expect.arrayContaining([expect.stringContaining("pagination cap")]),
    });
  });

  it("distinguishes blocked rate-limited repo fidelity from global service readiness", () => {
    const states = [repoState({ repoFullName: "owner/repo", status: "rate_limited" })];
    const segments = [segment({ repoFullName: "owner/repo", segment: "open_issues", status: "rate_limited", rateLimitResetAt: "2026-05-27T00:00:00.000Z" })];

    expect(buildSignalFidelity(1, states, segments)).toMatchObject({
      status: "blocked",
      repoCount: 1,
      blockedRepos: 1,
      rateLimitedRepos: ["owner/repo"],
      nextRecoverableAt: "2026-05-27T00:00:00.000Z",
    });
  });

  it("reports missing registered repo sync state as degraded fidelity", () => {
    expect(buildSignalFidelity(2, [repoState({ repoFullName: "owner/synced", status: "success" })], [])).toMatchObject({
      status: "degraded",
      completeRepos: 1,
      degradedRepos: 1,
    });
  });

  it("marks missing repo sync state as unknown at repo level", () => {
    expect(buildRepoDataQuality("owner/missing", null, [])).toMatchObject({
      status: "unknown",
      partial: false,
      capped: false,
      rateLimited: false,
      warnings: ["No repository sync state is available for owner/missing."],
    });
  });

  it("keeps complete and not-modified segments as complete freshness", () => {
    const quality = buildRepoDataQuality("owner/repo", repoState(), [
      segment({ segment: "metadata", status: "not_modified", fetchedCount: 1 }),
      segment({ segment: "labels", status: "complete", fetchedCount: 8 }),
    ]);

    expect(quality).toMatchObject({
      status: "complete",
      partial: false,
      stale: false,
      incompleteSegments: [],
      segmentCount: 2,
    });
  });

  it("does not carry historical sync errors into complete repo warnings", () => {
    const quality = buildRepoDataQuality("owner/repo", repoState({ status: "success", errorSummary: "old rate limit", warnings: ["old rate limit warning"] }), [
      segment({ segment: "metadata", status: "complete", fetchedCount: 1, expectedCount: 1 }),
      segment({ segment: "open_issues", status: "complete", fetchedCount: 10, expectedCount: 10 }),
    ]);

    expect(quality.status).toBe("complete");
    expect(quality.warnings).toEqual([]);
  });

  it("marks old sync completion timestamps as stale", () => {
    const quality = buildRepoDataQuality(
      "owner/repo",
      repoState({ lastCompletedAt: "2026-05-01T00:00:00.000Z" }),
      [segment({ segment: "open_issues", completedAt: "2026-05-01T00:00:00.000Z" })],
      { nowMs: Date.parse("2026-05-25T00:00:00.000Z") },
    );

    expect(quality).toMatchObject({
      status: "degraded",
      stale: true,
      staleSegments: ["open_issues"],
      warnings: expect.arrayContaining([expect.stringContaining("stale")]),
    });
  });

  it("treats explicit stale segment status as stale even without an old timestamp", () => {
    const quality = buildRepoDataQuality(
      "owner/repo",
      repoState(),
      [segment({ segment: "open_pull_requests", status: "stale", completedAt: "2026-05-25T00:00:00.000Z" })],
      { nowMs: Date.parse("2026-05-25T00:01:00.000Z") },
    );

    expect(quality).toMatchObject({
      status: "degraded",
      stale: true,
      staleSegments: ["open_pull_requests"],
    });
  });

  it("uses state warnings to expose cap and rate-limit risk even without segment rows", () => {
    const quality = buildRepoDataQuality(
      "owner/repo",
      repoState({ warnings: ["GitHub sync reached local cap.", "GitHub secondary rate limit observed."] }),
      [],
    );

    expect(quality).toMatchObject({
      status: "degraded",
      capped: true,
      rateLimited: true,
      warnings: expect.arrayContaining([
        "GitHub sync reached local cap.",
        "GitHub secondary rate limit observed.",
        expect.stringContaining("GitHub rate limiting"),
      ]),
    });
  });

  it("returns unknown signal fidelity when no registered repo data exists yet", () => {
    expect(buildSignalFidelity(0, [], [])).toMatchObject({
      status: "unknown",
      repoCount: 0,
      completeRepos: 0,
      degradedRepos: 0,
      blockedRepos: 0,
    });
  });

  it("uses the earliest recoverable rate-limit reset across segments", () => {
    expect(
      buildSignalFidelity(
        2,
        [repoState({ repoFullName: "owner/a", status: "rate_limited" }), repoState({ repoFullName: "owner/b", status: "rate_limited" })],
        [
          segment({ repoFullName: "owner/a", status: "rate_limited", rateLimitResetAt: "2026-05-27T12:00:00.000Z" }),
          segment({ repoFullName: "owner/b", status: "rate_limited", rateLimitResetAt: "2026-05-27T06:00:00.000Z" }),
        ],
      ),
    ).toMatchObject({
      status: "blocked",
      nextRecoverableAt: "2026-05-27T06:00:00.000Z",
      rateLimitedRepos: ["owner/a", "owner/b"],
    });
  });

  it("does not report stale recoverable times from completed segments", () => {
    const fidelity = buildSignalFidelity(
      1,
      [repoState({ repoFullName: "owner/recovered", status: "success" })],
      [segment({ repoFullName: "owner/recovered", status: "complete", rateLimitResetAt: "2026-05-27T00:00:00.000Z" })],
    );

    expect(fidelity.status).toBe("complete");
    expect(fidelity.nextRecoverableAt).toBeUndefined();
  });

  it("does not block repo fidelity when a rate-limited segment already has complete stored coverage", () => {
    const recoveredSegment = segment({
      repoFullName: "owner/recovered",
      segment: "recent_merged_pull_requests",
      status: "waiting_rate_limit",
      fetchedCount: 33,
      expectedCount: 33,
      rateLimitResetAt: "2026-05-27T00:00:00.000Z",
    });

    expect(buildRepoDataQuality("owner/recovered", repoState({ repoFullName: "owner/recovered" }), [recoveredSegment])).toMatchObject({
      status: "complete",
      partial: false,
      rateLimited: false,
      incompleteSegments: [],
      rateLimitedSegments: [],
    });
    expect(buildSignalFidelity(1, [repoState({ repoFullName: "owner/recovered" })], [recoveredSegment])).toMatchObject({
      status: "complete",
      blockedRepos: 0,
      rateLimitedRepos: [],
      nextRecoverableAt: undefined,
    });
  });

  it("keeps incomplete waiting-rate-limit segments blocked until coverage catches up", () => {
    const waitingSegment = segment({
      repoFullName: "owner/waiting",
      segment: "open_issues",
      status: "waiting_rate_limit",
      fetchedCount: 9,
      expectedCount: 10,
      rateLimitResetAt: "2026-05-27T00:00:00.000Z",
    });

    expect(buildRepoDataQuality("owner/waiting", repoState({ repoFullName: "owner/waiting" }), [waitingSegment])).toMatchObject({
      status: "blocked",
      partial: true,
      rateLimited: true,
      incompleteSegments: ["open_issues"],
      rateLimitedSegments: ["open_issues"],
    });
    expect(buildSignalFidelity(1, [repoState({ repoFullName: "owner/waiting" })], [waitingSegment])).toMatchObject({
      status: "blocked",
      blockedRepos: 1,
      rateLimitedRepos: ["owner/waiting"],
      nextRecoverableAt: "2026-05-27T00:00:00.000Z",
    });
  });

  it("requires authoritative open-data totals for core fidelity and treats history as sampled", () => {
    const segments = [
      segment({ segment: "metadata", fetchedCount: 1, expectedCount: 1 }),
      segment({ segment: "labels", fetchedCount: 2, expectedCount: 2 }),
      segment({ segment: "open_issues", fetchedCount: 2911, expectedCount: 2911 }),
      segment({ segment: "open_pull_requests", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_files", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_reviews", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "check_summaries", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "recent_merged_pull_requests", status: "sampled", fetchedCount: 200, expectedCount: 6411 }),
    ];
    const detailStates = Array.from({ length: 167 }, (_, index) => detailState(index + 1));

    expect(buildCoreSignalFidelity(1, [repoState()], segments, [totals()], detailStates)).toMatchObject({
      status: "complete",
      completeRepos: 1,
      incompleteRepos: [],
      historyCoverage: "sampled",
    });
  });

  it("does not count a refreshing segment as degraded when last complete coverage is still usable", () => {
    const segments = [
      segment({ segment: "metadata", fetchedCount: 1, expectedCount: 1 }),
      segment({ segment: "labels", fetchedCount: 2, expectedCount: 2 }),
      segment({ segment: "open_issues", status: "running", fetchedCount: 2911, expectedCount: 2911, completedAt: "2026-05-25T00:00:00.000Z" }),
      segment({ segment: "open_pull_requests", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_files", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_reviews", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "check_summaries", fetchedCount: 167, expectedCount: 167 }),
    ];
    const detailStates = Array.from({ length: 167 }, (_, index) => detailState(index + 1));

    expect(buildCoreSignalFidelity(1, [repoState({ status: "running" })], segments, [totals()], detailStates)).toMatchObject({
      status: "complete",
      completeRepos: 1,
      refreshingRepos: ["owner/repo"],
      incompleteRepos: [],
    });
  });

  it("marks core fidelity degraded when open issue fetch count is below GitHub totals", () => {
    const segments = [
      segment({ segment: "metadata", fetchedCount: 1, expectedCount: 1 }),
      segment({ segment: "labels", fetchedCount: 2, expectedCount: 2 }),
      segment({ segment: "open_issues", fetchedCount: 1100, expectedCount: 2911 }),
      segment({ segment: "open_pull_requests", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_files", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_reviews", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "check_summaries", fetchedCount: 167, expectedCount: 167 }),
    ];
    const detailStates = Array.from({ length: 167 }, (_, index) => detailState(index + 1));

    expect(buildCoreSignalFidelity(1, [repoState()], segments, [totals()], detailStates)).toMatchObject({
      status: "degraded",
      incompleteRepos: ["owner/repo"],
      degradedRepos: 1,
    });
  });

  it("separates blocked core fidelity from full historical coverage", () => {
    const segments = [
      segment({ segment: "metadata", fetchedCount: 1, expectedCount: 1 }),
      segment({ segment: "labels", fetchedCount: 2, expectedCount: 2 }),
      segment({ segment: "open_issues", status: "waiting_rate_limit", fetchedCount: 2900, expectedCount: 2911, rateLimitResetAt: "2026-05-25T14:25:55.000Z" }),
      segment({ segment: "open_pull_requests", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_files", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_reviews", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "check_summaries", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "recent_merged_pull_requests", fetchedCount: 6411, expectedCount: 6411 }),
    ];

    expect(buildCoreSignalFidelity(1, [repoState({ status: "rate_limited" })], segments, [totals()], [])).toMatchObject({
      status: "blocked",
      blockedRepos: 1,
      waitingForRateLimitRepos: ["owner/repo"],
      incompleteRepos: ["owner/repo"],
      historyCoverage: "full",
    });
  });

  it("keeps core fidelity complete when rate-limited required segments have last complete coverage", () => {
    const segments = [
      segment({ segment: "metadata", fetchedCount: 1, expectedCount: 1 }),
      segment({ segment: "labels", fetchedCount: 2, expectedCount: 2 }),
      segment({
        segment: "open_issues",
        status: "waiting_rate_limit",
        fetchedCount: 2911,
        expectedCount: 2911,
        completedAt: "2026-05-25T00:00:00.000Z",
        rateLimitResetAt: "2026-05-25T14:25:55.000Z",
      }),
      segment({ segment: "open_pull_requests", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_files", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "pull_request_reviews", fetchedCount: 167, expectedCount: 167 }),
      segment({ segment: "check_summaries", fetchedCount: 167, expectedCount: 167 }),
    ];
    const detailStates = Array.from({ length: 167 }, (_, index) => detailState(index + 1));

    expect(buildCoreSignalFidelity(1, [repoState({ status: "rate_limited" })], segments, [totals()], detailStates)).toMatchObject({
      status: "complete",
      completeRepos: 1,
      blockedRepos: 0,
      incompleteRepos: [],
      waitingForRateLimitRepos: [],
    });
  });

  it("returns unknown core fidelity before any repo signal exists", () => {
    expect(buildCoreSignalFidelity(0, [], [], [], [])).toMatchObject({
      status: "unknown",
      repoCount: 0,
      completeRepos: 0,
      historyCoverage: "counts_only",
    });
  });
});

function repoState(overrides: Partial<RepoSyncStateRecord> = {}): RepoSyncStateRecord {
  return {
    repoFullName: "owner/repo",
    status: "success",
    sourceKind: "github",
    openIssuesCount: 0,
    openPullRequestsCount: 0,
    recentMergedPullRequestsCount: 0,
    lastCompletedAt: "2026-05-25T00:00:00.000Z",
    warnings: [],
    ...overrides,
  };
}

function segment(overrides: Partial<RepoSyncSegmentRecord> = {}): RepoSyncSegmentRecord {
  return {
    repoFullName: "owner/repo",
    segment: "metadata",
    status: "complete",
    sourceKind: "github",
    mode: "light",
    fetchedCount: 1,
    pageCount: 1,
    completedAt: "2026-05-25T00:00:00.000Z",
    warnings: [],
    ...overrides,
  };
}

function totals(overrides: Partial<RepoGithubTotalsSnapshotRecord> = {}): RepoGithubTotalsSnapshotRecord {
  return {
    id: "totals-owner-repo",
    repoFullName: "owner/repo",
    openIssuesTotal: 2911,
    openPullRequestsTotal: 167,
    mergedPullRequestsTotal: 6411,
    closedUnmergedPullRequestsTotal: 776,
    labelsTotal: 2,
    sourceKind: "github",
    fetchedAt: "2026-05-25T00:00:00.000Z",
    payload: {},
    ...overrides,
  };
}

function detailState(pullNumber: number, overrides: Partial<PullRequestDetailSyncStateRecord> = {}): PullRequestDetailSyncStateRecord {
  return {
    repoFullName: "owner/repo",
    pullNumber,
    status: "complete",
    lastSyncedAt: "2026-05-25T00:00:00.000Z",
    updatedAt: "2026-05-25T00:00:00.000Z",
    ...overrides,
  };
}
