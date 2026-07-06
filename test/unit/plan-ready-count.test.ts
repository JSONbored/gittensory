import { describe, expect, it } from "vitest";

import { countPlanReadySteps } from "../../packages/gittensory-engine/src/plan-ready";
import type { PlanStep } from "../../packages/gittensory-engine/src/plan-export";
import { nextReadySteps } from "../../src/services/plan-dag";

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

describe("countPlanReadySteps", () => {
  it("returns zero for an empty plan", () => {
    expect(countPlanReadySteps({ steps: [] })).toBe(0);
  });

  it("returns one when a single pending step has no dependencies", () => {
    expect(
      countPlanReadySteps({
        steps: [step({ id: "a", title: "Build", status: "pending" })],
      }),
    ).toBe(1);
  });

  it("returns two when two independent pending steps are ready", () => {
    expect(
      countPlanReadySteps({
        steps: [
          step({ id: "a", title: "Build", status: "pending" }),
          step({ id: "b", title: "Test", status: "pending" }),
        ],
      }),
    ).toBe(2);
  });

  it("returns one when only the root pending step is ready in a chain", () => {
    expect(
      countPlanReadySteps({
        steps: [
          step({ id: "a", title: "Build", status: "pending" }),
          step({ id: "b", title: "Test", status: "pending", dependsOn: ["a"] }),
        ],
      }),
    ).toBe(1);
  });

  it("returns one when a pending step's dependencies are satisfied", () => {
    expect(
      countPlanReadySteps({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Test", status: "pending", dependsOn: ["a"] }),
        ],
      }),
    ).toBe(1);
  });

  it("returns zero for a cyclic deadlock with no ready steps", () => {
    expect(
      countPlanReadySteps({
        steps: [
          step({ id: "a", title: "A", dependsOn: ["b"] }),
          step({ id: "b", title: "B", dependsOn: ["a"] }),
        ],
      }),
    ).toBe(0);
  });

  it("returns zero when a pending step depends on a missing step id", () => {
    expect(
      countPlanReadySteps({
        steps: [step({ id: "a", title: "A", dependsOn: ["ghost"] })],
      }),
    ).toBe(0);
  });

  it("returns zero when every step is completed or skipped", () => {
    expect(
      countPlanReadySteps({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Deploy", status: "skipped" }),
        ],
      }),
    ).toBe(0);
  });

  it("matches hosted nextReadySteps(plan).length", () => {
    const plan = {
      steps: [
        step({ id: "a", title: "Build", status: "completed" }),
        step({ id: "b", title: "Test", status: "pending", dependsOn: ["a"] }),
        step({ id: "c", title: "Deploy", status: "pending" }),
      ],
    };
    expect(countPlanReadySteps(plan)).toBe(nextReadySteps(plan).length);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/gittensory-engine/src/index");
    expect(typeof barrel.countPlanReadySteps).toBe("function");
    expect(
      barrel.countPlanReadySteps({
        steps: [step({ id: "a", title: "A", status: "pending" })],
      }),
    ).toBe(1);
  });
});
