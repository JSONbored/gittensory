// Cross-module regression coverage for the full Phase 1 miner-discovery pipeline: AI-policy hard-skip,
// GitHub fan-out, goal-model lane-fit, and opportunity ranking composed in a single realistic scenario.
// Per-module edge cases belong in the individual unit test files (opportunity-ranker.test.ts,
// goal-model.test.ts, ai-policy-map.test.ts, opportunity-fanout-ai-policy.test.ts) — this test exists only
// to catch a future refactor of any one piece (ranker weights, goal-model matching, AI-policy phrases)
// breaking the composed behavior in a way the per-module suites wouldn't notice.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// Route the miner's bare "@jsonbored/gittensory-engine" import at the engine source (mirrors
// test/unit/opportunity-fanout-ai-policy.test.ts) so the fan-out and the ranker share the real engine code.
vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { fetchCandidateIssuesWithSummary } from "../../packages/gittensory-miner/lib/opportunity-fanout.js";
import { DEFAULT_MINER_GOAL_SPEC, rankMetadataOpportunities } from "@jsonbored/gittensory-engine";
import type { MetadataCandidateIssue } from "../../packages/gittensory-engine/src/opportunity-metadata";
import type { MinerGoalSpec } from "../../packages/gittensory-engine/src/miner-goal-spec";

const API = "https://api.test";
const NOW_MS = Date.parse("2026-07-09T00:00:00.000Z");
const NOW_ISO = new Date(NOW_MS).toISOString();
const STALE_ISO = new Date(NOW_MS - 400 * 86_400_000).toISOString();

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/ai-policy");

function readFixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8");
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return Response.json(body, {
    ...init,
    headers: {
      "x-ratelimit-remaining": "42",
      "x-ratelimit-reset": "1800000000",
      ...(init.headers ?? {}),
    },
  });
}

function contentResponse(content: string) {
  return jsonResponse({
    type: "file",
    encoding: "base64",
    content: Buffer.from(content, "utf8").toString("base64"),
  });
}

function ghIssue(overrides: {
  number: number;
  title: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}) {
  return {
    number: overrides.number,
    title: overrides.title,
    labels: overrides.labels,
    comments: 2,
    created_at: overrides.createdAt,
    updated_at: overrides.updatedAt,
    html_url: `https://github.com/acme/repo/issues/${overrides.number}`,
  };
}

// Every repo below shares potential (labels always include "help wanted", never a NEGATIVE_LABELS entry)
// and comment count, so the only things that can move a candidate's rank are the signal(s) each row is
// named for — the scenario is designed so each differentiator is isolated against this shared baseline.
const REPOS = {
  banned: "acme/banned",
  noConfig: "acme/noconfig",
  preferredLane: "acme/preferredlane",
  blockedPath: "acme/blockedpath",
  stale: "acme/stale",
  dupRisk: "acme/duprisk",
} as const;

// Synthetic per-issue "likely touched paths" a later analyze-phase would infer — GitHub issues carry no
// file paths of their own, so this augmentation happens after fan-out, mirroring how `candidatePaths` is
// documented as an optional post-fan-out annotation on `MetadataCandidateIssue`.
const CANDIDATE_PATHS: Record<string, readonly string[]> = {
  [REPOS.noConfig]: ["src/services/example.ts"],
  [REPOS.preferredLane]: ["src/services/example.ts"],
  [REPOS.blockedPath]: ["site/index.html"],
  [REPOS.stale]: ["src/services/example.ts"],
  [REPOS.dupRisk]: ["src/services/example.ts"],
};

const GOAL_SPECS: Record<string, MinerGoalSpec> = {
  [REPOS.preferredLane]: { ...DEFAULT_MINER_GOAL_SPEC, preferredLabels: ["priority-lane"] },
  [REPOS.blockedPath]: { ...DEFAULT_MINER_GOAL_SPEC, blockedPaths: ["site/**"] },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("miner-discovery Phase 1 pipeline (#2311): fan-out + AI-policy + goal-model + ranking", () => {
  it("hard-skips a banned repo, ranks the rest, and pins the exact composed order", async () => {
    const bannedPolicy = readFixture("banned-ai-usage.md");
    const allowedPolicy = readFixture("allowed-silent.md");

    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);

      if (url.includes("/repos/acme/banned/contents/AI-USAGE.md")) return contentResponse(bannedPolicy);
      if (url.includes("/repos/acme/banned/issues?")) {
        throw new Error("banned repo must be hard-skipped before its issues are listed");
      }

      if (url.includes("/contents/AI-USAGE.md")) return jsonResponse({}, { status: 404 });
      if (url.includes("/contents/CONTRIBUTING.md")) return contentResponse(allowedPolicy);

      if (url.includes("/repos/acme/noconfig/issues?")) {
        return jsonResponse([
          ghIssue({
            number: 101,
            title: "Add caching layer for repository metadata lookups",
            labels: ["help wanted"],
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
          }),
        ]);
      }
      if (url.includes("/repos/acme/preferredlane/issues?")) {
        return jsonResponse([
          ghIssue({
            number: 201,
            title: "Support custom retry backoff for webhook delivery",
            labels: ["help wanted", "priority-lane"],
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
          }),
        ]);
      }
      if (url.includes("/repos/acme/blockedpath/issues?")) {
        return jsonResponse([
          ghIssue({
            number: 301,
            title: "Normalize timestamps in the audit export pipeline",
            labels: ["help wanted"],
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
          }),
        ]);
      }
      if (url.includes("/repos/acme/stale/issues?")) {
        return jsonResponse([
          ghIssue({
            number: 401,
            title: "Improve error messages for invalid API tokens",
            labels: ["help wanted"],
            createdAt: STALE_ISO,
            updatedAt: STALE_ISO,
          }),
        ]);
      }
      if (url.includes("/repos/acme/duprisk/issues?")) {
        return jsonResponse([
          ghIssue({
            number: 501,
            title: "Flaky checkout retry timeout",
            labels: ["help wanted"],
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
          }),
          ghIssue({
            number: 502,
            title: "Flaky checkout retry timeout observed again in staging",
            labels: ["help wanted"],
            createdAt: NOW_ISO,
            updatedAt: NOW_ISO,
          }),
        ]);
      }
      return jsonResponse({}, { status: 404 });
    });

    // Stage 1: fan-out across 6 candidate repos, with the AI-policy hard-skip pre-filtering the banned one.
    const fanOut = await fetchCandidateIssuesWithSummary(
      [
        { owner: "acme", repo: "banned" },
        { owner: "acme", repo: "noconfig" },
        { owner: "acme", repo: "preferredlane" },
        { owner: "acme", repo: "blockedpath" },
        { owner: "acme", repo: "stale" },
        { owner: "acme", repo: "duprisk" },
      ],
      "placeholder-token",
      { apiBaseUrl: API },
    );

    expect(fanOut.warnings).toEqual([]);
    expect(fanOut.issues.map((issue) => issue.repoFullName)).toEqual([
      REPOS.noConfig,
      REPOS.preferredLane,
      REPOS.blockedPath,
      REPOS.stale,
      REPOS.dupRisk,
      REPOS.dupRisk,
    ]);

    // The banned repo cost exactly one GitHub call (its policy-doc fetch) and never reached the issues endpoint.
    const bannedCalls = calls.filter((url) => url.includes("/repos/acme/banned/"));
    expect(bannedCalls).toHaveLength(1);
    expect(bannedCalls[0]).toContain("/repos/acme/banned/contents/AI-USAGE.md");
    expect(calls.some((url) => url.includes("/repos/acme/banned/issues?"))).toBe(false);

    // Stage 2: attach post-fan-out path metadata and rank through the real goal-model + ranker composition.
    const candidates: MetadataCandidateIssue[] = fanOut.issues.map((issue) => ({
      repoFullName: issue.repoFullName,
      issueNumber: issue.issueNumber,
      title: issue.title,
      labels: issue.labels,
      candidatePaths: CANDIDATE_PATHS[issue.repoFullName],
      commentsCount: issue.commentsCount,
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
    }));

    const ranked = rankMetadataOpportunities(candidates, {
      nowMs: NOW_MS,
      goalSpecsByRepo: GOAL_SPECS,
    });

    // The literal expected order, hand-reasoned from the scenario: the perfectly-matching lane beats the
    // no-config neutral baseline; the duplicate-cluster pair (mutually deprioritized, tied with each other)
    // beats the stale issue; the blocked-path candidate collapses to dead last via the lane-fit short-circuit.
    expect(ranked.map((entry) => `${entry.repoFullName}#${entry.issueNumber}`)).toEqual([
      "acme/preferredlane#201",
      "acme/noconfig#101",
      "acme/duprisk#501",
      "acme/duprisk#502",
      "acme/stale#401",
      "acme/blockedpath#301",
    ]);

    // Pin each isolated mechanism explicitly, not just the resulting order.
    const byKey = new Map(ranked.map((entry) => [`${entry.repoFullName}#${entry.issueNumber}`, entry]));
    expect(byKey.get("acme/noconfig#101")?.laneFit).toBe(0.5); // absent .gittensory-miner.yml -> neutral default
    expect(byKey.get("acme/preferredlane#201")?.laneFit).toBe(1); // matches the repo's preferredLabels
    expect(byKey.get("acme/blockedpath#301")?.laneFit).toBe(0); // hits the repo's blockedPaths short-circuit
    expect(byKey.get("acme/stale#401")?.freshness).toBe(0.05); // 400-day-old issue floors out freshness
    expect(byKey.get("acme/duprisk#501")?.dupRisk).toBe(0.5); // overlapping in-batch titles raise dupRisk
    expect(byKey.get("acme/duprisk#502")?.dupRisk).toBe(0.5);

    // A byte-identical rerun with the same inputs must be deterministic (no Date.now()/random anywhere in
    // the composed path) so a future refactor introducing hidden nondeterminism fails this test immediately.
    const rankedAgain = rankMetadataOpportunities(candidates, { nowMs: NOW_MS, goalSpecsByRepo: GOAL_SPECS });
    expect(rankedAgain.map((entry) => `${entry.repoFullName}#${entry.issueNumber}`)).toEqual(
      ranked.map((entry) => `${entry.repoFullName}#${entry.issueNumber}`),
    );
  });
});
