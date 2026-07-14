import { describe, expect, it } from "vitest";

import { isPlanEmpty } from "../../packages/loopover-engine/src/plan-empty";
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

describe("isPlanEmpty", () => {
  it("returns true when the plan has no steps", () => {
    expect(isPlanEmpty({ steps: [] })).toBe(true);
  });

  it("returns false when the plan has at least one step", () => {
    expect(isPlanEmpty({ steps: [step({ id: "a", title: "Build" })] })).toBe(false);
    expect(
      isPlanEmpty({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Test", status: "pending" }),
        ],
      }),
    ).toBe(false);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/loopover-engine/src/index");
    expect(typeof barrel.isPlanEmpty).toBe("function");
    expect(barrel.isPlanEmpty({ steps: [] })).toBe(true);
    expect(barrel.isPlanEmpty({ steps: [step({ id: "a", title: "A" })] })).toBe(false);
  });
});
