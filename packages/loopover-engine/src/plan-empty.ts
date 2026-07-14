import type { PlanDag } from "./plan-export.js";

/**
 * Return whether the plan has no steps. Pure — reads the plan DAG only.
 */
export function isPlanEmpty(plan: PlanDag): boolean {
  return plan.steps.length === 0;
}
