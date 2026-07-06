import { describe, expect, it } from "vitest";
import { isImpactMapEnabled, shouldComputeImpactMap } from "../../src/review/impact-map-wire";

describe("isImpactMapEnabled", () => {
  it("is OFF for unset/false and ON for the truthy convention", () => {
    expect(isImpactMapEnabled({})).toBe(false);
    expect(isImpactMapEnabled({ GITTENSORY_REVIEW_IMPACT_MAP: "false" })).toBe(false);
    expect(isImpactMapEnabled({ GITTENSORY_REVIEW_IMPACT_MAP: "true" })).toBe(true);
    expect(isImpactMapEnabled({ GITTENSORY_REVIEW_IMPACT_MAP: "1" })).toBe(true);
    expect(isImpactMapEnabled({ GITTENSORY_REVIEW_IMPACT_MAP: "on" })).toBe(true);
    expect(isImpactMapEnabled({ GITTENSORY_REVIEW_IMPACT_MAP: "yes" })).toBe(true);
  });
});

describe("shouldComputeImpactMap", () => {
  it("requires BOTH the operator env flag AND the per-repo manifest opt-in", () => {
    expect(shouldComputeImpactMap({ GITTENSORY_REVIEW_IMPACT_MAP: "true" }, true)).toBe(true);
  });

  it("is OFF when the operator flag is on but the manifest didn't opt in", () => {
    expect(shouldComputeImpactMap({ GITTENSORY_REVIEW_IMPACT_MAP: "true" }, false)).toBe(false);
  });

  it("is OFF when the manifest opted in but the operator flag is off (repo cannot self-enable)", () => {
    expect(shouldComputeImpactMap({ GITTENSORY_REVIEW_IMPACT_MAP: "false" }, true)).toBe(false);
  });

  it("is OFF when both are off", () => {
    expect(shouldComputeImpactMap({}, false)).toBe(false);
  });
});
