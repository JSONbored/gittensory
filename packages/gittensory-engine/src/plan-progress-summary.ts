import type { PlanDag, PlanStepStatus } from "./plan-export.js";
import { resolvePlanOverallStatus, type PlanOverallStatus } from "./plan-overall-status.js";

export type PlanProgressSummary = {
  total: number;
  completed: number;
  failed: number;
  running: number;
  pending: number;
  skipped: number;
  status: PlanOverallStatus;
};

/**
 * Aggregate per-status counts plus overall status. Mirrors hosted `planProgress`. Pure — reads the plan DAG only.
 */
export function summarizePlanProgress(plan: PlanDag): PlanProgressSummary {
  const count = (status: PlanStepStatus) => plan.steps.filter((step) => step.status === status).length;
  return {
    total: plan.steps.length,
    completed: count("completed"),
    failed: count("failed"),
    running: count("running"),
    pending: count("pending"),
    skipped: count("skipped"),
    status: resolvePlanOverallStatus(plan),
  };
}
