// Pareto-floor comparator between two BacktestScoreReports (#8086) -- the dual-axis no-regression method:
// a candidate rule change may not regress on ANY measured axis even while improving another; "trading one
// axis for the other" is a regression, not a net win. This is deliberately NOT a weighted/averaged score --
// a single regressed axis decides the verdict, which is the entire point of the floor.
//
// Same purity contract as the rest of this module family: no IO, no randomness, no wall-clock reads.

import type { BacktestScoreReport } from "./backtest-score.js";

/** The two comparable axes of a {@link BacktestScoreReport}. */
type ComparisonAxis = "precision" | "recall";

export type BacktestComparison = {
  ruleId: string;
  baseline: BacktestScoreReport;
  candidate: BacktestScoreReport;
  regressedAxes: Array<"precision" | "recall">;
  improvedAxes: Array<"precision" | "recall">;
  verdict: "improved" | "regressed" | "unchanged";
};

/**
 * Compare a candidate rule change's backtest score against its baseline under the Pareto-floor rule: an
 * axis regresses when the candidate's value is strictly below the baseline's, improves when strictly above,
 * and is excluded from BOTH lists when either side is null (insufficient decided data is never treated as 0
 * or as "no change" -- the same "unknown stays unknown" discipline the reports themselves use). The verdict
 * is "regressed" whenever ANY axis regressed -- even if the other axis improved -- else "improved" when any
 * axis improved, else "unchanged". Throws when the two reports describe different rules: that is a caller
 * bug, not a valid comparison.
 */
export function compareBacktestScores(baseline: BacktestScoreReport, candidate: BacktestScoreReport): BacktestComparison {
  if (baseline.ruleId !== candidate.ruleId) {
    throw new Error(`cannot compare backtest scores for different rules: ${baseline.ruleId} vs ${candidate.ruleId}`);
  }
  const regressedAxes: ComparisonAxis[] = [];
  const improvedAxes: ComparisonAxis[] = [];
  for (const axis of ["precision", "recall"] as const) {
    const baselineValue = baseline[axis];
    const candidateValue = candidate[axis];
    if (baselineValue === null || candidateValue === null) continue;
    if (candidateValue < baselineValue) regressedAxes.push(axis);
    else if (candidateValue > baselineValue) improvedAxes.push(axis);
  }
  return {
    ruleId: baseline.ruleId,
    baseline,
    candidate,
    regressedAxes,
    improvedAxes,
    verdict: regressedAxes.length > 0 ? "regressed" : improvedAxes.length > 0 ? "improved" : "unchanged",
  };
}
