import { describe, expect, it } from "vitest";

import { pickTopRankedOpportunitiesAtOrAboveScore } from "../../packages/loopover-engine/src/ranked-opportunity-top-min-score";
import type { OpportunityRankInput } from "../../packages/loopover-engine/src/opportunity-ranker";

function input(over: Partial<OpportunityRankInput> = {}): OpportunityRankInput {
  return { potential: 1, feasibility: 1, laneFit: 1, freshness: 1, dupRisk: 0, ...over };
}

describe("pickTopRankedOpportunitiesAtOrAboveScore", () => {
  const candidates = [
    { id: "low", ...input({ potential: 0.2 }) },
    { id: "mid", ...input({ potential: 0.5 }) },
    { id: "top", ...input() },
    { id: "weak", ...input({ potential: 0.5, feasibility: 0.5, laneFit: 0.5 }) },
  ];

  it("returns the top survivors after applying the score threshold", () => {
    const topTwo = pickTopRankedOpportunitiesAtOrAboveScore(candidates, 0.5, 2);
    expect(topTwo.map((entry) => entry.id)).toEqual(["top", "mid"]);
    expect(topTwo.every((entry) => entry.rankScore >= 0.5)).toBe(true);
  });

  it("returns every qualifying candidate when the limit exceeds the filtered list", () => {
    expect(pickTopRankedOpportunitiesAtOrAboveScore(candidates, 0.125, 10).map((entry) => entry.id)).toEqual([
      "top",
      "mid",
      "low",
      "weak",
    ]);
  });

  it("returns an empty array when the score threshold excludes every candidate", () => {
    expect(
      pickTopRankedOpportunitiesAtOrAboveScore(
        [
          { id: "a", ...input({ potential: 0.2 }) },
          { id: "b", ...input({ potential: 0.3 }) },
        ],
        0.5,
        2,
      ),
    ).toEqual([]);
  });

  it("returns an empty array for a non-finite or zero limit", () => {
    expect(pickTopRankedOpportunitiesAtOrAboveScore(candidates, 0.5, 0)).toEqual([]);
    expect(pickTopRankedOpportunitiesAtOrAboveScore(candidates, 0.5, -1)).toEqual([]);
    expect(pickTopRankedOpportunitiesAtOrAboveScore(candidates, 0.5, Number.NaN)).toEqual([]);
    expect(pickTopRankedOpportunitiesAtOrAboveScore(candidates, 0.5, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("returns an empty array when minScore is non-finite", () => {
    expect(pickTopRankedOpportunitiesAtOrAboveScore(candidates, Number.NaN, 2)).toEqual([]);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/loopover-engine/src/index");
    expect(typeof barrel.pickTopRankedOpportunitiesAtOrAboveScore).toBe("function");
    expect(
      barrel.pickTopRankedOpportunitiesAtOrAboveScore(candidates, 0.5, 1).map((entry: { id: string }) => entry.id),
    ).toEqual(["top"]);
  });
});
