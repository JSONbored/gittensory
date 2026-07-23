import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConfidenceThresholdClassifier, runThresholdBacktest, type BacktestCase } from "../dist/index.js";

function corpusCase(targetKey: string, label: BacktestCase["label"], confidence?: number): BacktestCase {
  return {
    ruleId: "linked_issue_scope_mismatch",
    targetKey,
    outcome: "unaddressed",
    label,
    firedAt: "2026-07-22T00:00:00.000Z",
    decidedAt: "2026-07-22T01:00:00.000Z",
    ...(confidence !== undefined ? { metadata: { confidence } } : {}),
  };
}

test("barrel: the public entrypoint re-exports the threshold-backtest primitives (#8138)", () => {
  assert.equal(typeof buildConfidenceThresholdClassifier, "function");
  assert.equal(typeof runThresholdBacktest, "function");
});

test("buildConfidenceThresholdClassifier: below-threshold confidence predicts reversed", () => {
  const classify = buildConfidenceThresholdClassifier(0.5);
  assert.equal(classify(corpusCase("a#1", "reversed", 0.3)), "reversed");
});

test("buildConfidenceThresholdClassifier: at-or-above-threshold confidence predicts confirmed", () => {
  const classify = buildConfidenceThresholdClassifier(0.5);
  assert.equal(classify(corpusCase("a#1", "confirmed", 0.5)), "confirmed");
  assert.equal(classify(corpusCase("a#2", "confirmed", 1)), "confirmed");
});

test("buildConfidenceThresholdClassifier: missing confidence degrades to 1, never predicted reversed by default", () => {
  const classify = buildConfidenceThresholdClassifier(0.99);
  assert.equal(classify(corpusCase("a#1", "confirmed")), "confirmed");
});

test("runThresholdBacktest: an empty corpus reports unchanged with null precision/recall on both sides", () => {
  const comparison = runThresholdBacktest("linked_issue_scope_mismatch", [], 0.5, 0.3);
  assert.equal(comparison.verdict, "unchanged");
  assert.equal(comparison.baseline.precision, null);
  assert.equal(comparison.candidate.precision, null);
});

test("runThresholdBacktest: only scores cases matching the given ruleId", () => {
  const cases: BacktestCase[] = [
    { ...corpusCase("a#1", "reversed", 0.1), ruleId: "other_rule" },
    corpusCase("a#2", "confirmed", 0.9),
  ];
  const comparison = runThresholdBacktest("linked_issue_scope_mismatch", cases, 0.5, 0.3);
  assert.equal(comparison.baseline.caseCount, 1);
  assert.equal(comparison.candidate.caseCount, 1);
});

test("runThresholdBacktest: a lower floor that flips a correct reversed prediction to a missed one regresses recall", () => {
  const cases: BacktestCase[] = [corpusCase("a#1", "reversed", 0.35)];
  const comparison = runThresholdBacktest("linked_issue_scope_mismatch", cases, 0.5, 0.2);
  assert.equal(comparison.verdict, "regressed");
  assert.ok(comparison.regressedAxes.includes("recall"));
});
