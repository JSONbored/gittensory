import { describe, expect, it } from "vitest";

import { bestRankedOpportunity } from "../../packages/loopover-engine/src/ranked-opportunity-best-pick";
import type { OpportunityRankInput } from "../../packages/loopover-engine/src/opportunity-ranker";

function input(over: Partial<OpportunityRankInput> = {}): OpportunityRankInput {
  return { potential: 1, feasibility: 1, laneFit: 1, freshness: 1, dupRisk: 0, ...over };
}

describe("bestRankedOpportunity", () => {
  it("returns null for an empty candidate list", () => {
    expect(bestRankedOpportunity([])).toBeNull();
  });

  it("returns the highest-scoring candidate", () => {
    const best = bestRankedOpportunity([
      { id: "low", ...input({ potential: 0.2 }) },
      { id: "mid", ...input({ potential: 0.5 }) },
      { id: "top", ...input() },
    ]);
    expect(best?.id).toBe("top");
    expect(best?.rankScore).toBe(1);
  });

  it("breaks score ties by input order", () => {
    const tie = input({ potential: 0.5, feasibility: 0.5, laneFit: 0.5, freshness: 0.5 });
    const best = bestRankedOpportunity([
      { id: "first", ...tie },
      { id: "second", ...tie },
    ]);
    expect(best?.id).toBe("first");
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/loopover-engine/src/index");
    expect(typeof barrel.bestRankedOpportunity).toBe("function");
    expect(barrel.bestRankedOpportunity([{ id: "solo", ...input() }])?.id).toBe("solo");
  });
});
