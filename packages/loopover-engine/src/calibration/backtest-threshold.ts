// Threshold-only backtest (#8138) -- the honestly-backtestable slice of a confidence-floor change today:
// BacktestCase (#8083) stores outcome + metadata (e.g. { confidence }) but never the raw diff/issue content
// a rule evaluated, so a classifier can only re-simulate a decision using what's actually IN the corpus.
// Comparing a stored metadata.confidence against a NEW threshold value needs no raw content -- this is the
// one case the corpus already fully supports. Logic/regex-change backtesting needs raw context (#8129/#8130)
// and lives in a separate module once that lands.

import { compareBacktestScores, type BacktestComparison } from "./backtest-compare.js";
import type { BacktestCase } from "./backtest-corpus.js";
import { scoreBacktest } from "./backtest-score.js";

/**
 * Build a classify function that predicts `"reversed"` (the rule's original firing was wrong) when a
 * case's stored `metadata.confidence` is below `threshold`, `"confirmed"` otherwise. A case with no
 * numeric `metadata.confidence` degrades to confidence `1` -- mirrors this codebase's own established
 * "absent/unparseable confidence degrades to 1.0" fallback (see `LinkedIssueSatisfactionResult`'s own
 * confidence handling), so an unscored case is never predicted `"reversed"` by default.
 */
export function buildConfidenceThresholdClassifier(threshold: number): (backtestCase: BacktestCase) => "reversed" | "confirmed" {
  return (backtestCase) => {
    const confidence = typeof backtestCase.metadata?.confidence === "number" ? backtestCase.metadata.confidence : 1;
    return confidence < threshold ? "reversed" : "confirmed";
  };
}

/**
 * Backtest a proposed change to a single confidence threshold: score the OLD and NEW threshold values as
 * two classifiers over the same corpus (`scoreBacktest`, #8085), then compare them with the Pareto-floor
 * discipline (`compareBacktestScores`, #8086) -- a regression on either precision or recall wins, even if
 * the other axis improved. Pure; the corpus is the caller's responsibility to fetch/filter to one `ruleId`
 * first (the `cases` array may safely contain other ruleIds too -- both `scoreBacktest` calls filter on
 * `ruleId` internally).
 */
export function runThresholdBacktest(
  ruleId: string,
  cases: readonly BacktestCase[],
  oldThreshold: number,
  newThreshold: number,
): BacktestComparison {
  const baseline = scoreBacktest(ruleId, cases, buildConfidenceThresholdClassifier(oldThreshold));
  const candidate = scoreBacktest(ruleId, cases, buildConfidenceThresholdClassifier(newThreshold));
  return compareBacktestScores(baseline, candidate);
}
