import type { PlanDag } from "./plan-export.js";

/**
 * Return whether any step in the plan has failed. Pure — reads the plan DAG only.
 */
export function hasPlanFailedSteps(plan: PlanDag): boolean {
  return plan.steps.some((step) => step.status === "failed");
}
