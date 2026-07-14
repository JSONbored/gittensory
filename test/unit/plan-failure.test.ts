import { describe, expect, it } from "vitest";

import { hasPlanFailedSteps } from "../../packages/loopover-engine/src/plan-failure";
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

describe("hasPlanFailedSteps", () => {
  it("returns false for an empty plan", () => {
    expect(hasPlanFailedSteps({ steps: [] })).toBe(false);
  });

  it("returns false when no step has failed", () => {
    expect(
      hasPlanFailedSteps({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Test", status: "pending" }),
        ],
      }),
    ).toBe(false);
  });

  it("returns true when at least one step has failed", () => {
    expect(
      hasPlanFailedSteps({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Deploy", status: "failed" }),
        ],
      }),
    ).toBe(true);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/loopover-engine/src/index");
    expect(typeof barrel.hasPlanFailedSteps).toBe("function");
    expect(
      barrel.hasPlanFailedSteps({
        steps: [step({ id: "a", title: "A", status: "failed" })],
      }),
    ).toBe(true);
  });
});
