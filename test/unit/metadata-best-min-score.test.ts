import { describe, expect, it } from "vitest";

import { DEFAULT_MINER_GOAL_SPEC } from "../../packages/loopover-engine/src/miner-goal-spec";
import { bestMetadataOpportunityAtOrAboveScore } from "../../packages/loopover-engine/src/metadata-best-min-score";

const NOW = Date.parse("2026-07-03T12:00:00.000Z");

const base = {
  repoFullName: "acme/widgets",
  issueNumber: 10,
  title: "Improve queue retry semantics",
  labels: ["help wanted"],
  commentsCount: 2,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-02T12:00:00.000Z",
};

describe("bestMetadataOpportunityAtOrAboveScore", () => {
  const candidates = [
    { ...base, issueNumber: 1, labels: ["wontfix"] },
    { ...base, issueNumber: 2, labels: ["help wanted"] },
    { ...base, issueNumber: 3, labels: ["help wanted", "bug"] },
    { ...base, issueNumber: 4, labels: ["help wanted", "documentation"] },
  ];

  it("returns null for an empty candidate list", () => {
    expect(bestMetadataOpportunityAtOrAboveScore([], { nowMs: NOW }, 0.1)).toBeNull();
  });

  it("returns null when the score threshold excludes every candidate", () => {
    expect(bestMetadataOpportunityAtOrAboveScore(candidates, { nowMs: NOW }, 1)).toBeNull();
  });

  it("returns null for a non-finite threshold", () => {
    expect(bestMetadataOpportunityAtOrAboveScore(candidates, { nowMs: NOW }, Number.NaN)).toBeNull();
    expect(
      bestMetadataOpportunityAtOrAboveScore(candidates, { nowMs: NOW }, Number.POSITIVE_INFINITY),
    ).toBeNull();
  });

  it("returns the highest-scoring survivor at or above the threshold", () => {
    const best = bestMetadataOpportunityAtOrAboveScore(candidates, { nowMs: NOW }, 0.1);
    expect(best?.issueNumber).toBe(3);
    expect(best?.rankScore).toBeGreaterThanOrEqual(0.1);
  });

  it("returns null when every candidate is miner-disabled", () => {
    expect(
      bestMetadataOpportunityAtOrAboveScore(
        [{ ...base, issueNumber: 1, repoFullName: "acme/disabled" }],
        {
          nowMs: NOW,
          goalSpecsByRepo: {
            "acme/disabled": { ...DEFAULT_MINER_GOAL_SPEC, minerEnabled: false },
          },
        },
        0,
      ),
    ).toBeNull();
  });

  it("breaks score ties by input order among qualifying candidates", () => {
    const tie = { potential: 0.8, feasibility: 0.8, laneFit: 1, freshness: 1, dupRisk: 0 };
    const best = bestMetadataOpportunityAtOrAboveScore(
      [
        { ...base, issueNumber: 1, ...tie },
        { ...base, issueNumber: 2, ...tie },
      ],
      { nowMs: NOW },
      0.05,
    );
    expect(best?.issueNumber).toBe(1);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/loopover-engine/src/index");
    expect(typeof barrel.bestMetadataOpportunityAtOrAboveScore).toBe("function");
    expect(
      barrel.bestMetadataOpportunityAtOrAboveScore(candidates, { nowMs: NOW }, 0.1)?.issueNumber,
    ).toBe(3);
  });
});
