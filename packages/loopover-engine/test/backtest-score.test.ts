import assert from "node:assert/strict";
import { test } from "node:test";

import { scoreBacktest, type BacktestCase } from "../dist/index.js";

function corpusCase(targetKey: string, label: BacktestCase["label"], overrides: Partial<BacktestCase> = {}): BacktestCase {
  return {
    ruleId: "missing_linked_issue",
    targetKey,
    outcome: "block",
    label,
    firedAt: "2026-07-22T00:00:00.000Z",
    decidedAt: "2026-07-22T01:00:00.000Z",
    ...overrides,
  };
}

test("barrel: the public entrypoint re-exports the backtest scorer (#8085)", () => {
  assert.equal(typeof scoreBacktest, "function");
});

test("scoreBacktest: an all-correct classifier scores precision 1 and recall 1", () => {
  const cases = [
    corpusCase("a#1", "reversed"),
    corpusCase("a#2", "confirmed"),
    corpusCase("a#3", "reversed"),
  ];
  const report = scoreBacktest("missing_linked_issue", cases, (backtestCase) => backtestCase.label);
  assert.deepEqual(report, {
    ruleId: "missing_linked_issue",
    caseCount: 3,
    truePositive: 2,
    falsePositive: 0,
    trueNegative: 1,
    falseNegative: 0,
    precision: 1,
    recall: 1,
  });
});

test("scoreBacktest: an all-wrong classifier scores precision 0 and recall 0, with the misses in the right cells", () => {
  const cases = [corpusCase("a#1", "reversed"), corpusCase("a#2", "confirmed")];
  const report = scoreBacktest("missing_linked_issue", cases, (backtestCase) =>
    backtestCase.label === "reversed" ? "confirmed" : "reversed",
  );
  assert.deepEqual(report, {
    ruleId: "missing_linked_issue",
    caseCount: 2,
    truePositive: 0,
    falsePositive: 1, // predicted reversed on the confirmed-labeled case
    trueNegative: 0,
    falseNegative: 1, // predicted confirmed on the reversed-labeled case
    precision: 0,
    recall: 0,
  });
});

test("scoreBacktest: a mixed classifier accumulates all four confusion-matrix cells", () => {
  const cases = [
    corpusCase("a#1", "reversed"), // predicted reversed -> truePositive
    corpusCase("a#2", "confirmed"), // predicted reversed -> falsePositive
    corpusCase("a#3", "confirmed"), // predicted confirmed -> trueNegative
    corpusCase("a#4", "reversed"), // predicted confirmed -> falseNegative
  ];
  const predictReversedFor = new Set(["a#1", "a#2"]);
  const report = scoreBacktest("missing_linked_issue", cases, (backtestCase) =>
    predictReversedFor.has(backtestCase.targetKey) ? "reversed" : "confirmed",
  );
  assert.deepEqual(report, {
    ruleId: "missing_linked_issue",
    caseCount: 4,
    truePositive: 1,
    falsePositive: 1,
    trueNegative: 1,
    falseNegative: 1,
    precision: 0.5,
    recall: 0.5,
  });
});

test("scoreBacktest: an empty corpus reports zero counts with precision AND recall null", () => {
  const report = scoreBacktest("missing_linked_issue", [], () => "reversed");
  assert.deepEqual(report, {
    ruleId: "missing_linked_issue",
    caseCount: 0,
    truePositive: 0,
    falsePositive: 0,
    trueNegative: 0,
    falseNegative: 0,
    precision: null,
    recall: null,
  });
});

test("scoreBacktest: precision is null (not 0) when the classifier never predicts reversed, while recall stays real", () => {
  const report = scoreBacktest("missing_linked_issue", [corpusCase("a#1", "reversed")], () => "confirmed");
  assert.equal(report.precision, null); // truePositive + falsePositive === 0
  assert.equal(report.recall, 0); // truePositive / (0 + 1 falseNegative)
});

test("scoreBacktest: recall is null (not 0) when no case is labeled reversed, while precision stays real", () => {
  const report = scoreBacktest("missing_linked_issue", [corpusCase("a#1", "confirmed")], () => "reversed");
  assert.equal(report.recall, null); // truePositive + falseNegative === 0
  assert.equal(report.precision, 0); // truePositive / (0 + 1 falsePositive)
});

test("scoreBacktest: cases for a different ruleId are excluded from every count, caseCount included", () => {
  const report = scoreBacktest(
    "missing_linked_issue",
    [corpusCase("a#1", "reversed", { ruleId: "other_rule" }), corpusCase("a#2", "reversed")],
    () => "reversed",
  );
  assert.deepEqual(report, {
    ruleId: "missing_linked_issue",
    caseCount: 1,
    truePositive: 1,
    falsePositive: 0,
    trueNegative: 0,
    falseNegative: 0,
    precision: 1,
    recall: 1,
  });
});
