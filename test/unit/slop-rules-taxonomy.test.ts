import { describe, expect, it } from "vitest";
import { buildSlopRulesDocument, SLOP_RULES_URI } from "../../src/review/slop-rules-taxonomy";
import { ISSUE_SLOP_WEIGHTS, SLOP_WEIGHTS } from "../../src/signals/slop";

describe("slop-rules taxonomy document (#2237)", () => {
  it("projects every SLOP_WEIGHTS code + weight into pullRequestRules (single source of truth)", () => {
    const doc = buildSlopRulesDocument();
    const expected = Object.entries(SLOP_WEIGHTS);
    expect(doc.pullRequestRules).toHaveLength(expected.length);
    for (const [code, weight] of expected) {
      expect(doc.pullRequestRules).toContainEqual({ code, weight });
    }
  });

  it("projects every ISSUE_SLOP_WEIGHTS code + weight into issueRules", () => {
    const doc = buildSlopRulesDocument();
    const expected = Object.entries(ISSUE_SLOP_WEIGHTS);
    expect(doc.issueRules).toHaveLength(expected.length);
    for (const [code, weight] of expected) {
      expect(doc.issueRules).toContainEqual({ code, weight });
    }
  });

  it("enumerates the four score bands with their ranges", () => {
    const doc = buildSlopRulesDocument();
    expect(doc.bands.map((b) => b.band)).toEqual(["clean", "low", "elevated", "high"]);
    expect(doc.bands).toContainEqual({ band: "elevated", range: "31-59" });
  });

  it("exposes the stable resource URI", () => {
    expect(SLOP_RULES_URI).toBe("gittensory://slop-rules");
  });
});
