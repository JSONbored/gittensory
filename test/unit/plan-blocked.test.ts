import { describe, expect, it } from "vitest";

import { isPlanBlocked } from "../../packages/loopover-engine/src/plan-blocked";
import type { PlanStep } from "../../packages/loopover-engine/src/plan-export";

function step(over: Partial<PlanStep> & { id: string; title: string }): PlanStep {
  return {
    actionClass: undefined,
    dependsOn: [],
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    lastError: null,
    ...over,
  };
}

describe("isPlanBlocked", () => {
  it("returns false for an empty plan", () => {
    expect(isPlanBlocked({ steps: [] })).toBe(false);
  });

  it("returns false when pending steps are still runnable", () => {
    expect(
      isPlanBlocked({
        steps: [
          step({ id: "a", title: "Build", status: "pending" }),
          step({ id: "b", title: "Test", status: "pending", dependsOn: ["a"] }),
        ],
      }),
    ).toBe(false);
  });

  it("returns true for a cyclic deadlock with no ready steps", () => {
    expect(
      isPlanBlocked({
        steps: [
          step({ id: "a", title: "A", dependsOn: ["b"] }),
          step({ id: "b", title: "B", dependsOn: ["a"] }),
        ],
      }),
    ).toBe(true);
  });

  it("returns true when a pending step depends on a missing step id", () => {
    expect(
      isPlanBlocked({
        steps: [step({ id: "a", title: "A", dependsOn: ["ghost"] })],
      }),
    ).toBe(true);
  });

  it("returns false when a step failed (failed takes precedence over blocked)", () => {
    expect(
      isPlanBlocked({
        steps: [
          step({ id: "a", title: "A", dependsOn: ["b"], status: "failed" }),
          step({ id: "b", title: "B", dependsOn: ["a"] }),
        ],
      }),
    ).toBe(false);
  });

  it("returns false when a step is running", () => {
    expect(
      isPlanBlocked({
        steps: [
          step({ id: "a", title: "A", dependsOn: ["b"], status: "running" }),
          step({ id: "b", title: "B", dependsOn: ["a"] }),
        ],
      }),
    ).toBe(false);
  });

  it("returns false when every step is completed or skipped", () => {
    expect(
      isPlanBlocked({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Deploy", status: "skipped" }),
        ],
      }),
    ).toBe(false);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/loopover-engine/src/index");
    expect(typeof barrel.isPlanBlocked).toBe("function");
    expect(
      barrel.isPlanBlocked({
        steps: [step({ id: "a", title: "A", dependsOn: ["ghost"] })],
      }),
    ).toBe(true);
  });
});
