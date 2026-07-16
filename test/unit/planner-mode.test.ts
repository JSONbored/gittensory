import { describe, expect, it } from "vitest";
import { resolvePlannerEnabled } from "../../src/settings/planner-mode";

describe("resolvePlannerEnabled", () => {
  it("inherit defers to the global default in both directions", () => {
    expect(resolvePlannerEnabled(true, "inherit")).toBe(true);
    expect(resolvePlannerEnabled(false, "inherit")).toBe(false);
  });

  it("null/undefined mode behaves the same as inherit", () => {
    expect(resolvePlannerEnabled(true, null)).toBe(true);
    expect(resolvePlannerEnabled(false, undefined)).toBe(false);
  });

  it("off fully overrides a globally-ON default", () => {
    expect(resolvePlannerEnabled(true, "off")).toBe(false);
  });

  it("enabled fully overrides a globally-OFF default (symmetric)", () => {
    expect(resolvePlannerEnabled(false, "enabled")).toBe(true);
  });
});
