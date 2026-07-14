import { describe, expect, it } from "vitest";

import { isPlanTerminated } from "../../packages/loopover-engine/src/plan-terminated";
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

describe("isPlanTerminated", () => {
  it("returns false for an empty plan", () => {
    expect(isPlanTerminated({ steps: [] })).toBe(false);
  });

  it("returns false while work is still in flight", () => {
    expect(
      isPlanTerminated({
        steps: [
          step({ id: "a", title: "Build", status: "running" }),
          step({ id: "b", title: "Test", status: "pending" }),
        ],
      }),
    ).toBe(false);
  });

  it("returns true when any step failed", () => {
    expect(
      isPlanTerminated({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Deploy", status: "failed" }),
        ],
      }),
    ).toBe(true);
  });

  it("returns true when every step is completed or skipped", () => {
    expect(
      isPlanTerminated({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Deploy", status: "skipped" }),
        ],
      }),
    ).toBe(true);
  });

  it("returns false for a blocked cyclic deadlock", () => {
    expect(
      isPlanTerminated({
        steps: [
          step({ id: "a", title: "A", dependsOn: ["b"] }),
          step({ id: "b", title: "B", dependsOn: ["a"] }),
        ],
      }),
    ).toBe(false);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/loopover-engine/src/index");
    expect(typeof barrel.isPlanTerminated).toBe("function");
    expect(
      barrel.isPlanTerminated({
        steps: [step({ id: "a", title: "A", status: "failed" })],
      }),
    ).toBe(true);
  });
});
