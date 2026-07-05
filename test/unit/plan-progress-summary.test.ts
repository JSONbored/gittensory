import { describe, expect, it } from "vitest";

import { summarizePlanProgress } from "../../packages/gittensory-engine/src/plan-progress-summary";
import type { PlanStep } from "../../packages/gittensory-engine/src/plan-export";

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

describe("summarizePlanProgress", () => {
  it("returns zero counts and pending status for an empty plan", () => {
    expect(summarizePlanProgress({ steps: [] })).toEqual({
      total: 0,
      completed: 0,
      failed: 0,
      running: 0,
      pending: 0,
      skipped: 0,
      status: "pending",
    });
  });

  it("counts each status and resolves completed overall status", () => {
    expect(
      summarizePlanProgress({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Deploy", status: "skipped" }),
        ],
      }),
    ).toEqual({
      total: 2,
      completed: 1,
      failed: 0,
      running: 0,
      pending: 0,
      skipped: 1,
      status: "completed",
    });
  });

  it("reports failed status when any step failed", () => {
    expect(
      summarizePlanProgress({
        steps: [
          step({ id: "a", title: "Build", status: "running" }),
          step({ id: "b", title: "Deploy", status: "failed" }),
        ],
      }),
    ).toEqual({
      total: 2,
      completed: 0,
      failed: 1,
      running: 1,
      pending: 0,
      skipped: 0,
      status: "failed",
    });
  });

  it("reports running status when a step is in flight and none failed", () => {
    expect(
      summarizePlanProgress({
        steps: [
          step({ id: "a", title: "Build", status: "running" }),
          step({ id: "b", title: "Test", status: "pending" }),
        ],
      }),
    ).toEqual({
      total: 2,
      completed: 0,
      failed: 0,
      running: 1,
      pending: 1,
      skipped: 0,
      status: "running",
    });
  });

  it("reports blocked status for a cyclic deadlock", () => {
    expect(
      summarizePlanProgress({
        steps: [
          step({ id: "a", title: "A", dependsOn: ["b"] }),
          step({ id: "b", title: "B", dependsOn: ["a"] }),
        ],
      }),
    ).toEqual({
      total: 2,
      completed: 0,
      failed: 0,
      running: 0,
      pending: 2,
      skipped: 0,
      status: "blocked",
    });
  });

  it("reports pending status when runnable steps remain", () => {
    expect(
      summarizePlanProgress({
        steps: [
          step({ id: "a", title: "Build", status: "pending" }),
          step({ id: "b", title: "Test", status: "pending", dependsOn: ["a"] }),
        ],
      }),
    ).toEqual({
      total: 2,
      completed: 0,
      failed: 0,
      running: 0,
      pending: 2,
      skipped: 0,
      status: "pending",
    });
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/gittensory-engine/src/index");
    expect(typeof barrel.summarizePlanProgress).toBe("function");
    expect(
      barrel.summarizePlanProgress({
        steps: [step({ id: "a", title: "A", status: "completed" })],
      }),
    ).toEqual({
      total: 1,
      completed: 1,
      failed: 0,
      running: 0,
      pending: 0,
      skipped: 0,
      status: "completed",
    });
  });
});
