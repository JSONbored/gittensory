// Pareto-floor comparator between two BacktestScoreReports (#8086) -- the dual-axis no-regression method:
// a candidate rule change may not regress on ANY measured axis even while improving another; "trading one
// axis for the other" is a regression, not a net win. This is deliberately NOT a weighted/averaged score --
// a single regressed axis decides the verdict, which is the entire point of the floor.
//
// Same purity contract as the rest of this module family: no IO, no randomness, no wall-clock reads.

import type { BacktestScoreReport } from "./backtest-score.js";

/** The two comparable axes of a {@link BacktestScoreReport}. */
export type ComparisonAxis = "precision" | "recall";

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

/** The explicit axes orientation of a directional comparison (#8225): which axis the change exists to move
 *  (and must move strictly up to earn "improved"), and how much the OTHER axis may be sacrificed for it. */
export type DirectionalOrientation = {
  mustImprove: ComparisonAxis;
  /** Absolute drop the non-`mustImprove` axis may suffer before the trade is a regression. */
  maxSacrifice: number;
};

/**
 * Direction-aware comparator for a deliberate axis trade (#8225) -- a TIGHTENING exists to move one axis at
 * a bounded cost to the other, so reusing the symmetric {@link compareBacktestScores} blind would brand
 * every honest trade "regressed" the moment the sacrificed axis dips. Which axis is which depends on the
 * corpus polarity (for the confidence-threshold classifier the positive class is "predicted reversed", so
 * RAISING a threshold helps recall and risks precision -- the inverse of the rule-firing frame), hence the
 * orientation is the CALLER's explicit declaration, never an assumption baked in here. The re-oriented
 * floor:
 *   • the `mustImprove` axis must move STRICTLY up for an "improved" verdict, and any drop on it is
 *     "regressed" -- a trade that loses the axis it exists to win is simply wrong;
 *   • the other axis may drop by at most `maxSacrifice`; a within-bound drop is the accepted trade and
 *     appears in NEITHER axis list, an over-bound drop is "regressed", and a gain still counts;
 *   • a null on either side of an axis excludes that axis entirely -- unknown stays unknown, exactly as in
 *     the symmetric comparator (so a corpus with no judgeable win-axis can never yield "improved").
 * Throws on a rule mismatch or a non-finite/negative bound: both are caller bugs, not valid comparisons.
 */
export function compareDirectionalBacktestScores(
  baseline: BacktestScoreReport,
  candidate: BacktestScoreReport,
  orientation: DirectionalOrientation,
): BacktestComparison {
  if (baseline.ruleId !== candidate.ruleId) {
    throw new Error(`cannot compare backtest scores for different rules: ${baseline.ruleId} vs ${candidate.ruleId}`);
  }
  if (!Number.isFinite(orientation.maxSacrifice) || orientation.maxSacrifice < 0) {
    throw new Error(`maxSacrifice must be a non-negative finite number, got ${orientation.maxSacrifice}`);
  }
  const sacrificeAxis: ComparisonAxis = orientation.mustImprove === "precision" ? "recall" : "precision";
  const regressedAxes: ComparisonAxis[] = [];
  const improvedAxes: ComparisonAxis[] = [];
  const winBaseline = baseline[orientation.mustImprove];
  const winCandidate = candidate[orientation.mustImprove];
  if (winBaseline !== null && winCandidate !== null) {
    if (winCandidate < winBaseline) regressedAxes.push(orientation.mustImprove);
    else if (winCandidate > winBaseline) improvedAxes.push(orientation.mustImprove);
  }
  const sacBaseline = baseline[sacrificeAxis];
  const sacCandidate = candidate[sacrificeAxis];
  if (sacBaseline !== null && sacCandidate !== null) {
    if (sacBaseline - sacCandidate > orientation.maxSacrifice) regressedAxes.push(sacrificeAxis);
    else if (sacCandidate > sacBaseline) improvedAxes.push(sacrificeAxis);
  }
  return {
    ruleId: baseline.ruleId,
    baseline,
    candidate,
    regressedAxes,
    improvedAxes,
    // "improved" requires the WIN axis specifically -- a lone gain on the sacrifice axis is not what the
    // trade is for, so it stays "unchanged" (harmless, but no evidence the step earned its keep).
    verdict: regressedAxes.length > 0 ? "regressed" : improvedAxes.includes(orientation.mustImprove) ? "improved" : "unchanged",
  };
}
