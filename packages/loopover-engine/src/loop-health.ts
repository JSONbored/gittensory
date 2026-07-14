// Loop health / anomaly evaluator (pure) — the alert-rule logic behind internal ops observability for active
// rented loops (#4808, part of the Rent-a-Loop path #4778). Given one loop's already-computed run metrics it
// classifies health and flags the anomalies an operator should be alerted on, so a dashboard/alert surface
// consumes one deterministic verdict instead of re-deriving thresholds per panel. No IO, no transport —
// mirrors the per-tenant quota evaluator (#4796) and the loop-progress model (#4800).

// A resource is flagged "near" its ceiling at this % of budget consumed; at 100% it escalates to critical.
export const LOOP_HEALTH_WARN_PCT = 80;
// Consecutive no-progress iterations before the stall is treated as an anomaly (one flat iteration can be normal).
export const LOOP_HEALTH_NO_PROGRESS_STREAK = 2;

export type LoopHealthStatus = "healthy" | "degraded" | "critical";

export type LoopHealthInput = {
  iteration: number;
  maxIterations?: number | null | undefined;
  costUsed?: number | null | undefined;
  costCeiling?: number | null | undefined;
  noProgressStreak?: number | undefined;
  errored?: boolean | undefined;
  stalled?: boolean | undefined;
};

export type LoopHealthReport = {
  status: LoopHealthStatus;
  /** Alert-worthy anomaly codes, e.g. `errored`, `stalled`, `no_progress`, `near_iteration_budget`, `near_cost_ceiling`. */
  anomalies: string[];
  /** Iteration budget consumed (0-100), or null when the budget is unknown. */
  iterationBudgetUsedPct: number | null;
  /** Cost budget consumed (0-100), or null when the ceiling is unknown. */
  costUsedPct: number | null;
};

/** Classify one loop's health and flag its alert-worthy anomalies from already-computed metrics (#4808). Pure. */
export function evaluateLoopHealth(input: LoopHealthInput): LoopHealthReport {
  const iterationBudgetUsedPct =
    input.maxIterations !== null && input.maxIterations !== undefined && input.maxIterations > 0
      ? Math.min(100, Math.round((input.iteration / input.maxIterations) * 100))
      : null;
  const costUsedPct =
    input.costUsed !== null && input.costUsed !== undefined && input.costCeiling !== null && input.costCeiling !== undefined && input.costCeiling > 0
      ? Math.min(100, Math.round((input.costUsed / input.costCeiling) * 100))
      : null;

  const anomalies: string[] = [];
  if (input.errored === true) anomalies.push("errored");
  if (input.stalled === true) anomalies.push("stalled");
  if ((input.noProgressStreak ?? 0) >= LOOP_HEALTH_NO_PROGRESS_STREAK) anomalies.push("no_progress");
  if (iterationBudgetUsedPct !== null && iterationBudgetUsedPct >= LOOP_HEALTH_WARN_PCT) anomalies.push("near_iteration_budget");
  if (costUsedPct !== null && costUsedPct >= LOOP_HEALTH_WARN_PCT) anomalies.push("near_cost_ceiling");

  // Critical when a hard ceiling is hit or the loop has errored; degraded when any softer anomaly is present.
  const critical =
    input.errored === true ||
    (iterationBudgetUsedPct !== null && iterationBudgetUsedPct >= 100) ||
    (costUsedPct !== null && costUsedPct >= 100);
  const status: LoopHealthStatus = critical ? "critical" : anomalies.length > 0 ? "degraded" : "healthy";

  return { status, anomalies, iterationBudgetUsedPct, costUsedPct };
}
