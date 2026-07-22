// Backtest confusion-matrix scorer (#8085) -- replays a caller-supplied candidate classifier over a labeled
// BacktestCase corpus (#8083) and scores it against the real human verdicts, answering "if THIS version of
// the rule had been run against the same targets, would it have gotten more of them right?". Mirrors
// src/review/auto-tune.ts's GateEvalRow confusion-matrix shape (wouldMerge/mergeConfirmed/mergeFalse/
// decided/mergePrecision), but at a backtest-replay grain instead of a live-eval grain.
//
// Same purity contract as the rest of this module family: no IO, no randomness, no wall-clock reads.

import type { BacktestCase } from "./backtest-corpus.js";

// Convention: "reversed" is the positive class. A classifier that correctly predicts a case's real
// label of "reversed" (i.e. correctly identifies that the rule's original firing was WRONG) is a true
// positive. This is a deliberate, non-obvious choice — keep this comment attached to the type.
export type BacktestScoreReport = {
  ruleId: string;
  caseCount: number;
  truePositive: number;
  falsePositive: number;
  trueNegative: number;
  falseNegative: number;
  precision: number | null;
  recall: number | null;
};

/**
 * Score `classify` against every case in `cases` carrying this `ruleId`, accumulating the four
 * confusion-matrix counts against the real human labels ("reversed" is the positive class -- see the
 * report type's own convention comment). Cases for a different `ruleId` are excluded from every count,
 * `caseCount` included -- mirrors computeRulePrecision's (signal-tracking.ts) defensive override filter.
 * `precision`/`recall` are null when their denominator is 0, never coerced to 0 or 1 -- the same "unknown
 * stays unknown" discipline as RulePrecisionReport.precision. `classify` is deliberately synchronous: every
 * case must be scorable without I/O, so a caller can replay thousands of historical cases against a fast,
 * in-memory candidate rule implementation.
 */
export function scoreBacktest(
  ruleId: string,
  cases: readonly BacktestCase[],
  classify: (backtestCase: BacktestCase) => "reversed" | "confirmed",
): BacktestScoreReport {
  let caseCount = 0;
  let truePositive = 0;
  let falsePositive = 0;
  let trueNegative = 0;
  let falseNegative = 0;
  for (const backtestCase of cases) {
    if (backtestCase.ruleId !== ruleId) continue;
    caseCount += 1;
    const predicted = classify(backtestCase);
    if (predicted === "reversed") {
      if (backtestCase.label === "reversed") truePositive += 1;
      else falsePositive += 1;
    } else if (backtestCase.label === "confirmed") trueNegative += 1;
    else falseNegative += 1;
  }
  return {
    ruleId,
    caseCount,
    truePositive,
    falsePositive,
    trueNegative,
    falseNegative,
    precision: truePositive + falsePositive > 0 ? truePositive / (truePositive + falsePositive) : null,
    recall: truePositive + falseNegative > 0 ? truePositive / (truePositive + falseNegative) : null,
  };
}
