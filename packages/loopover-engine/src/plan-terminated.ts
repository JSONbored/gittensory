import type { PlanDag } from "./plan-export.js";
import { hasPlanFailedSteps } from "./plan-failure.js";
import { isPlanProgressComplete } from "./plan-progress-complete.js";

/**
 * Return whether the plan reached a terminal outcome: any step `failed`, or every step is `completed` or `skipped`.
 * Empty plans are not terminated. Pure.
 */
export function isPlanTerminated(plan: PlanDag): boolean {
  return hasPlanFailedSteps(plan) || isPlanProgressComplete(plan);
}
