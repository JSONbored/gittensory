import { describe, expect, it, vi } from "vitest";
import { persistSignalSnapshot, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import {
  REPO_OUTCOME_PATTERNS_MAX_AGE_MS,
  REPO_OUTCOME_PATTERNS_SIGNAL,
  loadOrComputeRepoOutcomePatternsResponse,
  loadRepoOutcomePatternsMap,
} from "../../src/services/repo-outcome-patterns";
import { createTestEnv } from "../helpers/d1";

function snapshotPayload(repoFullName: string, summary: string) {
  return {
    repoFullName,
    generatedAt: new Date().toISOString(),
    lane: "direct_pr",
    primaryLanguage: "TypeScript",
    sampleSize: 0,
    totals: { analyzed: 0, merged: 0, closedUnmerged: 0, openActive: 0, openStale: 0, maintainerLanePullRequests: 0, outsideContributorPullRequests: 0 },
    outsideContributorMergeRate: 0,
    maintainerLaneMergeRate: 0,
    dimensions: [],
    successPatterns: [],
    riskPatterns: [],
    evidenceCompleteness: { pullRequestsAnalyzed: 0, withFileDetail: 0, withReviewDetail: 0, withCheckDetail: 0, filesCompletenessRatio: 0, reviewsCompletenessRatio: 0, checksCompletenessRatio: 0, fullyDecidedWithDetail: 0, status: "missing" },
    findings: [],
    summary,
  };
}

describe("loadOrComputeRepoOutcomePatternsResponse", () => {
  it("returns null when the repo is unknown and has no snapshot", async () => {
    const env = createTestEnv();
    const response = await loadOrComputeRepoOutcomePatternsResponse(env, "ghost/missing");
    expect(response).toBeNull();
  });

  it("serves a snapshot envelope with freshness:fresh when recently persisted", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "fresh", full_name: "owner/fresh", private: false, owner: { login: "owner" }, default_branch: "main" });
    const generatedAt = new Date(Date.now() - 60_000).toISOString();
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_OUTCOME_PATTERNS_SIGNAL,
      targetKey: "owner/fresh",
      repoFullName: "owner/fresh",
      payload: { ...snapshotPayload("owner/fresh", "cached fixture"), generatedAt } as unknown as Record<string, never>,
      generatedAt,
    });
    const response = await loadOrComputeRepoOutcomePatternsResponse(env, "owner/fresh");
    expect(response).toMatchObject({ status: "ready", source: "snapshot", freshness: "fresh", patterns: { summary: "cached fixture" } });
    expect(response?.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  it("flags freshness:stale once the snapshot is older than the max age", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "old", full_name: "owner/old", private: false, owner: { login: "owner" }, default_branch: "main" });
    const generatedAt = new Date(Date.now() - REPO_OUTCOME_PATTERNS_MAX_AGE_MS - 60_000).toISOString();
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_OUTCOME_PATTERNS_SIGNAL,
      targetKey: "owner/old",
      repoFullName: "owner/old",
      payload: { ...snapshotPayload("owner/old", "stale fixture"), generatedAt } as unknown as Record<string, never>,
      generatedAt,
    });
    const response = await loadOrComputeRepoOutcomePatternsResponse(env, "owner/old");
    expect(response).toMatchObject({ status: "ready", source: "snapshot", freshness: "stale" });
  });

  it("falls back to a computed envelope when a known repo has no snapshot yet", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "uncached", full_name: "owner/uncached", private: false, owner: { login: "owner" }, default_branch: "main" });
    const response = await loadOrComputeRepoOutcomePatternsResponse(env, "owner/uncached");
    expect(response).toMatchObject({ status: "ready", source: "computed", freshness: "fresh", patterns: { repoFullName: "owner/uncached" } });
  });

  it("does not call broad request-time PR listers when a cached snapshot exists", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "perf", full_name: "owner/perf", private: false, owner: { login: "owner" }, default_branch: "main" });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_OUTCOME_PATTERNS_SIGNAL,
      targetKey: "owner/perf",
      repoFullName: "owner/perf",
      payload: snapshotPayload("owner/perf", "cached fixture") as unknown as Record<string, never>,
      generatedAt: new Date(Date.now() - 1000).toISOString(),
    });
    const repositoriesModule = await import("../../src/db/repositories");
    const spies = [
      vi.spyOn(repositoriesModule, "listPullRequests"),
      vi.spyOn(repositoriesModule, "listRecentMergedPullRequests"),
      vi.spyOn(repositoriesModule, "listRepoPullRequestFiles"),
      vi.spyOn(repositoriesModule, "listRepoPullRequestReviews"),
      vi.spyOn(repositoriesModule, "listPullRequestDetailSyncStates"),
    ];
    await loadOrComputeRepoOutcomePatternsResponse(env, "owner/perf");
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});

describe("loadRepoOutcomePatternsMap", () => {
  it("bulk-loads cached snapshots for registered repos only", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "a", full_name: "owner/a", private: false, owner: { login: "owner" }, default_branch: "main" });
    await persistSignalSnapshot(env, {
      id: crypto.randomUUID(),
      signalType: REPO_OUTCOME_PATTERNS_SIGNAL,
      targetKey: "owner/a",
      repoFullName: "owner/a",
      payload: snapshotPayload("owner/a", "cached") as unknown as Record<string, never>,
      generatedAt: new Date().toISOString(),
    });
    const map = await loadRepoOutcomePatternsMap(env, [
      { fullName: "owner/a", isRegistered: true },
      { fullName: "owner/b", isRegistered: true },
      { fullName: "owner/c", isRegistered: false }, // skipped
    ]);
    expect([...map.keys()]).toEqual(["owner/a"]);
  });
});
