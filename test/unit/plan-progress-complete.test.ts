import { describe, expect, it } from "vitest";

import { isPlanProgressComplete } from "../../packages/gittensory-engine/src/plan-progress-complete";
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

describe("isPlanProgressComplete", () => {
  it("returns false for an empty plan", () => {
    expect(isPlanProgressComplete({ steps: [] })).toBe(false);
  });

  it("returns false when any step is still in flight", () => {
    expect(
      isPlanProgressComplete({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Test", status: "pending" }),
        ],
      }),
    ).toBe(false);
  });

  it("returns false when any step failed", () => {
    expect(
      isPlanProgressComplete({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Deploy", status: "failed" }),
        ],
      }),
    ).toBe(false);
  });

  it("returns true when every step is completed", () => {
    expect(
      isPlanProgressComplete({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Test", status: "completed" }),
        ],
      }),
    ).toBe(true);
  });

  it("returns true when steps are completed or skipped", () => {
    expect(
      isPlanProgressComplete({
        steps: [
          step({ id: "a", title: "Build", status: "completed" }),
          step({ id: "b", title: "Deploy", status: "skipped" }),
        ],
      }),
    ).toBe(true);
  });

  it("is exported from the package barrel", async () => {
    const barrel = await import("../../packages/gittensory-engine/src/index");
    expect(typeof barrel.isPlanProgressComplete).toBe("function");
    expect(
      barrel.isPlanProgressComplete({
        steps: [
          step({ id: "a", title: "A", status: "completed" }),
          step({ id: "b", title: "B", status: "skipped" }),
        ],
      }),
    ).toBe(true);
  });
});
