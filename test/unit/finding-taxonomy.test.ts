import { describe, expect, it } from "vitest";
import { FINDING_CATEGORIES } from "../../src/review/finding-category-classify";
import { buildFindingTaxonomyDocument, FINDING_TAXONOMY_URI } from "../../src/review/finding-taxonomy";
import { REVIEW_FINDING_SEVERITY_LADDER } from "../../src/signals/focus-manifest";

describe("finding taxonomy document", () => {
  it("exposes the canonical category enum and severity ladder", () => {
    const doc = buildFindingTaxonomyDocument();
    expect(doc.categories).toEqual([...FINDING_CATEGORIES]);
    expect(doc.severities).toEqual([...REVIEW_FINDING_SEVERITY_LADDER]);
  });

  it("includes every category and severity value exactly once", () => {
    const doc = buildFindingTaxonomyDocument();
    for (const category of FINDING_CATEGORIES) {
      expect(doc.categories).toContain(category);
    }
    for (const severity of REVIEW_FINDING_SEVERITY_LADDER) {
      expect(doc.severities).toContain(severity);
    }
    expect(new Set(doc.categories).size).toBe(FINDING_CATEGORIES.length);
    expect(new Set(doc.severities).size).toBe(REVIEW_FINDING_SEVERITY_LADDER.length);
  });

  it("uses the stable MCP resource URI", () => {
    expect(FINDING_TAXONOMY_URI).toBe("loopover://finding-taxonomy");
  });
});
