import type { PlanDag } from "./plan-export.js";

/**
 * Return whether every step is terminal success (`completed` or `skipped`). Empty plans are not complete. Mirrors
 * the `completed` branch of hosted `planProgress` (distinct from `isPlanFullyCompleted`, which requires every
 * step to be `completed`). Pure — reads the plan DAG only.
 */
export function isPlanProgressComplete(plan: PlanDag): boolean {
  if (plan.steps.length === 0) return false;
  return plan.steps.every((step) => step.status === "completed" || step.status === "skipped");
}
