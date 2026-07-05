import type { PlanDag, PlanStep, PlanStepStatus } from "./plan-export.js";

const isDone = (status: PlanStepStatus): boolean => status === "completed" || status === "skipped";

function nextReadySteps(plan: PlanDag): PlanStep[] {
  const statusById = new Map(plan.steps.map((step) => [step.id, step.status]));
  return plan.steps.filter(
    (step) => step.status === "pending" && step.dependsOn.every((dep) => isDone(statusById.get(dep) ?? "pending")),
  );
}

/**
 * Return whether the plan is deadlocked: pending steps remain but none are runnable. Mirrors the `blocked`
 * branch of hosted `planProgress` — failed or running plans are not considered blocked. Pure.
 */
export function isPlanBlocked(plan: PlanDag): boolean {
  const total = plan.steps.length;
  if (total === 0) return false;
  const completed = plan.steps.filter((step) => step.status === "completed").length;
  const skipped = plan.steps.filter((step) => step.status === "skipped").length;
  if (completed + skipped === total) return false;
  if (plan.steps.some((step) => step.status === "failed")) return false;
  if (plan.steps.some((step) => step.status === "running")) return false;
  const pending = plan.steps.some((step) => step.status === "pending");
  return pending && nextReadySteps(plan).length === 0;
}
