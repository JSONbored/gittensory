import { describe, expect, it } from "vitest";

import { hasPlanReadySteps } from "../../packages/loopover-engine/src/plan-ready";
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

describe("hasPlanReadySteps", () => {
  it("returns false for an empty plan", () => {
    expect(hasPlanReadySteps({ steps: [] })).toBe(false);
  });

  it("returns true when a pending step has no dependencies", () => {
    expect(
      hasPlanReadySteps({
        steps: [step({ id: "a", title: "Build", status: "pending" })],
      }),
    ).toBe(true);
  });

  it("returns true when a pending step's dependencies are satisfied", () => {
    expect(
      hasPlanReadySteps({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Test", status: "pending", dependsOn: ["a"] }),
        ],
      }),
    ).toBe(true);
  });

  it("returns true when only the root pending step is ready in a chain", () => {
    expect(
      hasPlanReadySteps({
        steps: [
          step({ id: "a", title: "Build", status: "pending" }),
          step({ id: "b", title: "Test", status: "pending", dependsOn: ["a"] }),
        ],
      }),
    ).toBe(true);
  });

  it("returns false for a cyclic deadlock with no ready steps", () => {
    expect(
      hasPlanReadySteps({
        steps: [
          step({ id: "a", title: "A", dependsOn: ["b"] }),
          step({ id: "b", title: "B", dependsOn: ["a"] }),
        ],
      }),
    ).toBe(false);
  });

  it("returns false when a pending step depends on a missing step id", () => {
    expect(
      hasPlanReadySteps({
        steps: [step({ id: "a", title: "A", dependsOn: ["ghost"] })],
      }),
    ).toBe(false);
  });

  it("returns false when every step is completed or skipped", () => {
    expect(
      hasPlanReadySteps({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Deploy", status: "skipped" }),
        ],
      }),
    ).toBe(false);
  });

  it("returns false when only running or failed steps remain", () => {
    expect(
      hasPlanReadySteps({
        steps: [
          step({ id: "a", title: "Build", status: "running" }),
          step({ id: "b", title: "Deploy", status: "failed" }),
        ],
      }),
    ).toBe(false);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/loopover-engine/src/index");
    expect(typeof barrel.hasPlanReadySteps).toBe("function");
    expect(
      barrel.hasPlanReadySteps({
        steps: [step({ id: "a", title: "A", status: "pending" })],
      }),
    ).toBe(true);
  });
});
