import { describe, expect, it } from "vitest";
import { evaluateLoopHealth, LOOP_HEALTH_WARN_PCT } from "../../packages/loopover-engine/src/loop-health";

describe("evaluateLoopHealth (#4808)", () => {
  it("is healthy with budget percentages when nothing is anomalous", () => {
    const r = evaluateLoopHealth({ iteration: 1, maxIterations: 5, costUsed: 10, costCeiling: 100 });
    expect(r).toEqual({ status: "healthy", anomalies: [], iterationBudgetUsedPct: 20, costUsedPct: 10 });
  });

  it("leaves budget percentages null when the budgets are unknown or zero", () => {
    expect(evaluateLoopHealth({ iteration: 3 }).iterationBudgetUsedPct).toBeNull(); // no maxIterations
    expect(evaluateLoopHealth({ iteration: 3, maxIterations: 0 }).iterationBudgetUsedPct).toBeNull(); // 0 budget
    expect(evaluateLoopHealth({ iteration: 3, maxIterations: 5, costUsed: 5 }).costUsedPct).toBeNull(); // no ceiling
    expect(evaluateLoopHealth({ iteration: 3, maxIterations: 5, costUsed: 5, costCeiling: 0 }).costUsedPct).toBeNull(); // 0 ceiling
  });

  it("flags errored as critical", () => {
    const r = evaluateLoopHealth({ iteration: 1, maxIterations: 5, errored: true });
    expect(r.status).toBe("critical");
    expect(r.anomalies).toContain("errored");
  });

  it("flags a stall as degraded", () => {
    const r = evaluateLoopHealth({ iteration: 1, maxIterations: 5, stalled: true });
    expect(r).toMatchObject({ status: "degraded", anomalies: ["stalled"] });
  });

  it("flags a no-progress streak at/above the threshold, but not a single flat iteration", () => {
    expect(evaluateLoopHealth({ iteration: 3, maxIterations: 10, noProgressStreak: 2 }).anomalies).toContain("no_progress");
    expect(evaluateLoopHealth({ iteration: 3, maxIterations: 10, noProgressStreak: 1 }).anomalies).not.toContain("no_progress");
  });

  it("warns near a budget and escalates to critical at the ceiling", () => {
    // 80% iteration budget => degraded warning, not yet critical
    const warn = evaluateLoopHealth({ iteration: 4, maxIterations: 5 });
    expect(warn).toMatchObject({ status: "degraded", iterationBudgetUsedPct: LOOP_HEALTH_WARN_PCT });
    expect(warn.anomalies).toContain("near_iteration_budget");
    // at/over the iteration ceiling => critical (and the percentage caps at 100)
    const hit = evaluateLoopHealth({ iteration: 7, maxIterations: 5 });
    expect(hit).toMatchObject({ status: "critical", iterationBudgetUsedPct: 100 });
  });

  it("applies the same warn/critical logic to the cost ceiling independently of iterations", () => {
    const warn = evaluateLoopHealth({ iteration: 1, maxIterations: 10, costUsed: 80, costCeiling: 100 });
    expect(warn).toMatchObject({ status: "degraded", costUsedPct: 80 });
    expect(warn.anomalies).toContain("near_cost_ceiling");
    const hit = evaluateLoopHealth({ iteration: 1, maxIterations: 10, costUsed: 100, costCeiling: 100 });
    expect(hit.status).toBe("critical");
  });
});
