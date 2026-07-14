import { describe, expect, it } from "vitest";

import { hasPlanRunningSteps } from "../../packages/loopover-engine/src/plan-running";
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

describe("hasPlanRunningSteps", () => {
  it("returns false for an empty plan", () => {
    expect(hasPlanRunningSteps({ steps: [] })).toBe(false);
  });

  it("returns false when no step is running", () => {
    expect(
      hasPlanRunningSteps({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Test", status: "pending" }),
        ],
      }),
    ).toBe(false);
  });

  it("returns true when at least one step is running", () => {
    expect(
      hasPlanRunningSteps({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Deploy", status: "running", attempts: 1 }),
        ],
      }),
    ).toBe(true);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/loopover-engine/src/index");
    expect(typeof barrel.hasPlanRunningSteps).toBe("function");
    expect(
      barrel.hasPlanRunningSteps({
        steps: [step({ id: "a", title: "A", status: "running", attempts: 1 })],
      }),
    ).toBe(true);
  });
});
