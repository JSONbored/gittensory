import type { PlanDag } from "./plan-export.js";

/**
 * Return whether any step in the plan is currently running. Pure — reads the plan DAG only.
 */
export function hasPlanRunningSteps(plan: PlanDag): boolean {
  return plan.steps.some((step) => step.status === "running");
}
