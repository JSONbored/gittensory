import assert from "node:assert/strict";
import { test } from "node:test";

import { computeRegressedVerdictTrackRecord, compareBacktestScores, type BacktestComparison, type BacktestScoreReport } from "../dist/index.js";

// #8140: the REGRESSED-verdict track-record aggregation feeding #8105's Phase-2 merge-gating decision.

function score(ruleId: string, overrides: Partial<BacktestScoreReport> = {}): BacktestScoreReport {
  return { ruleId, caseCount: 10, truePositive: 4, falsePositive: 1, trueNegative: 4, falseNegative: 1, precision: 0.8, recall: 0.8, ...overrides };
}

function comparison(ruleId: string, candidate: Partial<BacktestScoreReport>): BacktestComparison {
  return compareBacktestScores(score(ruleId), score(ruleId, candidate));
}

test("zero runs -> zero totals and a null rate (unknown stays unknown, never coerced to 0)", () => {
  const record = computeRegressedVerdictTrackRecord([]);
  assert.equal(record.totalRuns, 0);
  assert.equal(record.regressedRuns, 0);
  assert.equal(record.regressedRate, null);
  assert.equal(record.perRule.size, 0);
});

test("all-clean runs -> regressedRuns 0 with a real 0 rate", () => {
  const record = computeRegressedVerdictTrackRecord([comparison("a", { precision: 0.9 }), comparison("a", {})]);
  assert.equal(record.totalRuns, 2);
  assert.equal(record.regressedRuns, 0);
  assert.equal(record.regressedRate, 0);
  assert.deepEqual(record.perRule.get("a"), { total: 2, regressed: 0, improved: 1, unchanged: 1 });
});

test("some-regressed runs -> counted in the totals and the rate", () => {
  const record = computeRegressedVerdictTrackRecord([
    comparison("a", { precision: 0.6 }),
    comparison("a", { precision: 0.9 }),
    comparison("a", { recall: 0.5 }),
    comparison("a", {}),
  ]);
  assert.equal(record.totalRuns, 4);
  assert.equal(record.regressedRuns, 2);
  assert.equal(record.regressedRate, 0.5);
});

test("per-ruleId breakdown separates more than one ruleId", () => {
  const record = computeRegressedVerdictTrackRecord([
    comparison("rule_a", { precision: 0.6 }),
    comparison("rule_a", { precision: 0.95 }),
    comparison("rule_b", {}),
  ]);
  assert.deepEqual(record.perRule.get("rule_a"), { total: 2, regressed: 1, improved: 1, unchanged: 0 });
  assert.deepEqual(record.perRule.get("rule_b"), { total: 1, regressed: 0, improved: 0, unchanged: 1 });
  assert.equal(record.perRule.size, 2);
});
