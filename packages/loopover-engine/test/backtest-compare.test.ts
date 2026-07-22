import assert from "node:assert/strict";
import { test } from "node:test";

import { compareBacktestScores, type BacktestScoreReport } from "../dist/index.js";

function report(overrides: Partial<BacktestScoreReport> = {}): BacktestScoreReport {
  return {
    ruleId: "missing_linked_issue",
    caseCount: 10,
    truePositive: 4,
    falsePositive: 2,
    trueNegative: 3,
    falseNegative: 1,
    precision: 0.5,
    recall: 0.5,
    ...overrides,
  };
}

test("barrel: the public entrypoint re-exports the Pareto-floor comparator (#8086)", () => {
  assert.equal(typeof compareBacktestScores, "function");
});

test("compareBacktestScores: both axes improving is an improved verdict with empty regressedAxes", () => {
  const comparison = compareBacktestScores(report(), report({ precision: 0.7, recall: 0.6 }));
  assert.deepEqual(comparison.improvedAxes, ["precision", "recall"]);
  assert.deepEqual(comparison.regressedAxes, []);
  assert.equal(comparison.verdict, "improved");
});

test("compareBacktestScores: PARETO FLOOR -- one axis improving while the other regresses is a regressed verdict", () => {
  const comparison = compareBacktestScores(report(), report({ precision: 0.9, recall: 0.3 }));
  assert.deepEqual(comparison.improvedAxes, ["precision"]);
  assert.deepEqual(comparison.regressedAxes, ["recall"]);
  assert.equal(comparison.verdict, "regressed");
});

test("compareBacktestScores: an axis with a null on either side is excluded from both lists", () => {
  const nullBaseline = compareBacktestScores(report({ precision: null }), report({ precision: 0.9, recall: 0.6 }));
  assert.deepEqual(nullBaseline.improvedAxes, ["recall"]);
  assert.deepEqual(nullBaseline.regressedAxes, []);
  assert.equal(nullBaseline.verdict, "improved");

  const nullCandidate = compareBacktestScores(report(), report({ recall: null }));
  assert.deepEqual(nullCandidate.improvedAxes, []);
  assert.deepEqual(nullCandidate.regressedAxes, []);
  assert.equal(nullCandidate.verdict, "unchanged");
});

test("compareBacktestScores: equal non-null axes land in neither list and yield an unchanged verdict", () => {
  const comparison = compareBacktestScores(report(), report());
  assert.deepEqual(comparison.improvedAxes, []);
  assert.deepEqual(comparison.regressedAxes, []);
  assert.equal(comparison.verdict, "unchanged");
  assert.equal(comparison.ruleId, "missing_linked_issue");
});

test("compareBacktestScores: mismatched ruleIds throw, naming both rules", () => {
  assert.throws(
    () => compareBacktestScores(report(), report({ ruleId: "other_rule" })),
    /cannot compare backtest scores for different rules: missing_linked_issue vs other_rule/,
  );
});
