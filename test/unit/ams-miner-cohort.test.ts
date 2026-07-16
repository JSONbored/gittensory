import { describe, expect, it } from "vitest";
import { AMS_MINER_COHORT_CHECK_CAP, buildAmsMinerCohortComparison, computeCohortMetrics, splitCohortRows } from "../../src/review/ams-miner-cohort";
import { REPUTATION_WINDOW_DAYS, type SubmitterCohortRow } from "../../src/review/submitter-reputation";
import type { AmsTrackRecordFetch } from "../../src/review/ams-reputation-bridge";

const ENDPOINT = "https://ams.internal";

function row(overrides: Partial<SubmitterCohortRow> = {}): SubmitterCohortRow {
  return { submitter: "alice", submissions: 10, merged: 7, closed: 3, avgAttemptCount: 1.5, avgMergeMs: 3_600_000, ...overrides };
}

/** A fetchImpl returning `outcomesByLogin[login] ?? []` as the { pullRequests } envelope, matching
 *  ams-reputation-bridge.test.ts's own jsonFetch convention. */
function trackRecordFetch(outcomesByLogin: Record<string, unknown[]>): AmsTrackRecordFetch {
  return async (url: string) => {
    const login = decodeURIComponent(url.split("/track-record/")[1] ?? "");
    return {
      ok: true,
      status: 200,
      json: async () => ({ pullRequests: outcomesByLogin[login] ?? [] }),
    } as unknown as Response;
  };
}

function amsOutcome(login: string) {
  return { repoFullName: "acme/widgets", authorLogin: login, state: "merged" };
}

describe("computeCohortMetrics (pure) (#6488)", () => {
  it("returns the empty-metrics shape for zero rows", () => {
    expect(computeCohortMetrics([])).toEqual({ submitterCount: 0, prVolume: 0, acceptanceRate: null, avgReviewCycleCount: null, avgTimeToMergeMs: null });
  });

  it("aggregates prVolume, acceptanceRate, and both averages across multiple submitters", () => {
    const rows = [row({ submitter: "alice", submissions: 10, merged: 7, closed: 3, avgAttemptCount: 1.5, avgMergeMs: 1_000 }), row({ submitter: "bob", submissions: 4, merged: 1, closed: 1, avgAttemptCount: 2.5, avgMergeMs: 3_000 })];
    const metrics = computeCohortMetrics(rows);
    expect(metrics.submitterCount).toBe(2);
    expect(metrics.prVolume).toBe(14);
    expect(metrics.acceptanceRate).toBeCloseTo(8 / 12); // merged 7+1 / terminal (7+3)+(1+1)
    expect(metrics.avgReviewCycleCount).toBeCloseTo(2); // mean of 1.5 and 2.5
    expect(metrics.avgTimeToMergeMs).toBeCloseTo(2_000); // mean of 1000 and 3000
  });

  it("acceptanceRate is null (never fabricated 0) when the cohort has zero terminal rows", () => {
    const metrics = computeCohortMetrics([row({ merged: 0, closed: 0 })]);
    expect(metrics.acceptanceRate).toBeNull();
  });

  it("avgTimeToMergeMs is null when no row in the cohort has a merge", () => {
    const metrics = computeCohortMetrics([row({ merged: 0, closed: 3, avgMergeMs: null })]);
    expect(metrics.avgTimeToMergeMs).toBeNull();
  });
});

describe("splitCohortRows (pure) (#6488)", () => {
  it("splits rows by membership, case-insensitively", () => {
    const rows = [row({ submitter: "Alice" }), row({ submitter: "bob" }), row({ submitter: "carol" })];
    const { ams, human } = splitCohortRows(rows, new Set(["alice"]));
    expect(ams.map((r) => r.submitter)).toEqual(["Alice"]);
    expect(human.map((r) => r.submitter)).toEqual(["bob", "carol"]);
  });

  it("an empty membership set puts every row in the human cohort", () => {
    const rows = [row({ submitter: "alice" }), row({ submitter: "bob" })];
    const { ams, human } = splitCohortRows(rows, new Set());
    expect(ams).toEqual([]);
    expect(human).toHaveLength(2);
  });
});

describe("buildAmsMinerCohortComparison (#6488)", () => {
  const enabledEnv = { LOOPOVER_REVIEW_AMS_REPUTATION_BRIDGE: "true", LOOPOVER_AMS_TRACK_RECORD_URL: ENDPOINT } as unknown as Env;

  it("present: false when the bridge feature flag is off (no DB read attempted)", async () => {
    const env = { DB: { prepare: () => { throw new Error("should not query when the bridge is off"); } } } as unknown as Env;
    await expect(buildAmsMinerCohortComparison(env, "acme/widgets")).resolves.toEqual({
      present: false,
      windowDays: 0,
      totalSubmitterCount: 0,
      checkedSubmitterCount: 0,
      amsCohort: { submitterCount: 0, prVolume: 0, acceptanceRate: null, avgReviewCycleCount: null, avgTimeToMergeMs: null },
      humanCohort: { submitterCount: 0, prVolume: 0, acceptanceRate: null, avgReviewCycleCount: null, avgTimeToMergeMs: null },
    });
  });

  it("present: false when the bridge is on but no endpoint is configured", async () => {
    const env = { LOOPOVER_REVIEW_AMS_REPUTATION_BRIDGE: "true", DB: { prepare: () => { throw new Error("should not query"); } } } as unknown as Env;
    const result = await buildAmsMinerCohortComparison(env, "acme/widgets");
    expect(result.present).toBe(false);
  });

  it("present: false (empty state, not an error) when the repo has no submitter activity in the window", async () => {
    const env = { ...enabledEnv, DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }) } } as unknown as Env;
    const result = await buildAmsMinerCohortComparison(env, "acme/widgets");
    expect(result.present).toBe(false);
    expect(result.windowDays).toBe(REPUTATION_WINDOW_DAYS);
  });

  it("classifies submitters into AMS vs human cohorts using the bridge's own live lookup", async () => {
    const rows = [row({ submitter: "alice", submissions: 10, merged: 7, closed: 3 }), row({ submitter: "bob", submissions: 4, merged: 1, closed: 1 })];
    const env = { ...enabledEnv, DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } } as unknown as Env;
    const fetchImpl = trackRecordFetch({ alice: [amsOutcome("alice")] }); // alice has AMS data, bob does not

    const result = await buildAmsMinerCohortComparison(env, "acme/widgets", { fetchImpl });

    expect(result.present).toBe(true);
    expect(result.totalSubmitterCount).toBe(2);
    expect(result.checkedSubmitterCount).toBe(2);
    expect(result.amsCohort.submitterCount).toBe(1);
    expect(result.amsCohort.prVolume).toBe(10);
    expect(result.humanCohort.submitterCount).toBe(1);
    expect(result.humanCohort.prVolume).toBe(4);
  });

  it("a login the bridge fails to resolve (null, fail-safe) is never counted as AMS", async () => {
    const rows = [row({ submitter: "alice" })];
    const env = { ...enabledEnv, DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } } as unknown as Env;
    const fetchImpl: AmsTrackRecordFetch = async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response;

    const result = await buildAmsMinerCohortComparison(env, "acme/widgets", { fetchImpl });

    expect(result.amsCohort.submitterCount).toBe(0);
    expect(result.humanCohort.submitterCount).toBe(1);
  });

  it("a login the bridge resolves with zero matching outcomes is not counted as AMS", async () => {
    const rows = [row({ submitter: "alice" })];
    const env = { ...enabledEnv, DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } } as unknown as Env;
    const fetchImpl = trackRecordFetch({}); // alice resolves, but with no outcomes

    const result = await buildAmsMinerCohortComparison(env, "acme/widgets", { fetchImpl });

    expect(result.amsCohort.submitterCount).toBe(0);
    expect(result.humanCohort.submitterCount).toBe(1);
  });

  it("REGRESSION: caps live lookups at AMS_MINER_COHORT_CHECK_CAP, defaulting every unchecked submitter to the human cohort", async () => {
    const rowCount = AMS_MINER_COHORT_CHECK_CAP + 5;
    const rows = Array.from({ length: rowCount }, (_unused, i) => row({ submitter: `submitter-${i}`, submissions: rowCount - i }));
    const env = { ...enabledEnv, DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } } as unknown as Env;
    let calls = 0;
    const fetchImpl: AmsTrackRecordFetch = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ pullRequests: [] }) } as unknown as Response;
    };

    const result = await buildAmsMinerCohortComparison(env, "acme/widgets", { fetchImpl });

    expect(calls).toBe(AMS_MINER_COHORT_CHECK_CAP);
    expect(result.totalSubmitterCount).toBe(rowCount);
    expect(result.checkedSubmitterCount).toBe(AMS_MINER_COHORT_CHECK_CAP);
    expect(result.humanCohort.submitterCount).toBe(rowCount); // none matched AMS, so all land in human
  });

  it("threads a custom windowDays option through to the underlying query and the response", async () => {
    const seenBindArgs: unknown[][] = [];
    const env = {
      ...enabledEnv,
      DB: {
        prepare: () => ({
          bind: (...args: unknown[]) => {
            seenBindArgs.push(args);
            return { all: async () => ({ results: [] }) };
          },
        }),
      },
    } as unknown as Env;

    const result = await buildAmsMinerCohortComparison(env, "acme/widgets", { windowDays: 14 });

    expect(seenBindArgs[0]).toEqual(["acme/widgets", "-14 days"]);
    expect(result.windowDays).toBe(14);
  });
});
