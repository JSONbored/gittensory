import { describe, expect, it } from "vitest";
import { parseFocusManifest, resolveReviewPromptOverrides, reviewConfigToJson } from "../../src/signals/focus-manifest";

describe("review.auto_merge_summary wiring (#2051)", () => {
  it("resolveReviewPromptOverrides resolves true only when explicitly enabled", () => {
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { auto_merge_summary: true } })).autoMergeSummary).toBe(true);
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: { auto_merge_summary: false } })).autoMergeSummary).toBe(false);
    expect(resolveReviewPromptOverrides(parseFocusManifest({ review: {} })).autoMergeSummary).toBe(false);
    expect(resolveReviewPromptOverrides(null).autoMergeSummary).toBe(false);
  });

  it("reviewConfigToJson round-trips auto_merge_summary through parseFocusManifest", () => {
    const on = parseFocusManifest({ review: { auto_merge_summary: true } });
    const json = reviewConfigToJson(on.review);
    expect(json).toEqual({ auto_merge_summary: true });
    expect(parseFocusManifest({ review: json }).review.autoMergeSummary).toBe(true);
  });
});
