import { describe, expect, it } from "vitest";

// Import the engine SOURCE directly (not the built dist) -- coverage.include lists
// packages/loopover-engine/src/**, so only a source-path import exercises the .ts these branches live in
// (the dist-importing twin in packages/loopover-engine/test/ covers the built barrel for the workspace
// suite). Same pattern as backtest-corpus-engine.test.ts / miner-deny-hook-synthesis.test.ts.
import { scoreBacktest } from "../../packages/loopover-engine/src/calibration/backtest-score";
import type { BacktestCase } from "../../packages/loopover-engine/src/calibration/backtest-corpus";

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

describe("scoreBacktest (#8085)", () => {
  it("scores an all-correct classifier at precision 1 / recall 1", () => {
    const cases = [corpusCase("a#1", "reversed"), corpusCase("a#2", "confirmed"), corpusCase("a#3", "reversed")];
    expect(scoreBacktest("missing_linked_issue", cases, (backtestCase) => backtestCase.label)).toEqual({
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

  it("scores an all-wrong classifier at precision 0 / recall 0 with the misses in the right cells", () => {
    const cases = [corpusCase("a#1", "reversed"), corpusCase("a#2", "confirmed")];
    expect(
      scoreBacktest("missing_linked_issue", cases, (backtestCase) =>
        backtestCase.label === "reversed" ? "confirmed" : "reversed",
      ),
    ).toEqual({
      ruleId: "missing_linked_issue",
      caseCount: 2,
      truePositive: 0,
      falsePositive: 1,
      trueNegative: 0,
      falseNegative: 1,
      precision: 0,
      recall: 0,
    });
  });

  it("accumulates all four confusion-matrix cells for a mixed classifier", () => {
    const cases = [
      corpusCase("a#1", "reversed"),
      corpusCase("a#2", "confirmed"),
      corpusCase("a#3", "confirmed"),
      corpusCase("a#4", "reversed"),
    ];
    const predictReversedFor = new Set(["a#1", "a#2"]);
    expect(
      scoreBacktest("missing_linked_issue", cases, (backtestCase) =>
        predictReversedFor.has(backtestCase.targetKey) ? "reversed" : "confirmed",
      ),
    ).toEqual({
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

  it("reports zero counts with precision AND recall null for an empty corpus", () => {
    expect(scoreBacktest("missing_linked_issue", [], () => "reversed")).toEqual({
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

  it("keeps precision null (not 0) when the classifier never predicts reversed, while recall stays real", () => {
    const report = scoreBacktest("missing_linked_issue", [corpusCase("a#1", "reversed")], () => "confirmed");
    expect(report.precision).toBeNull();
    expect(report.recall).toBe(0);
  });

  it("keeps recall null (not 0) when no case is labeled reversed, while precision stays real", () => {
    const report = scoreBacktest("missing_linked_issue", [corpusCase("a#1", "confirmed")], () => "reversed");
    expect(report.recall).toBeNull();
    expect(report.precision).toBe(0);
  });

  it("excludes cases for a different ruleId from every count, caseCount included", () => {
    const report = scoreBacktest(
      "missing_linked_issue",
      [corpusCase("a#1", "reversed", { ruleId: "other_rule" }), corpusCase("a#2", "reversed")],
      () => "reversed",
    );
    expect(report.caseCount).toBe(1);
    expect(report.truePositive).toBe(1);
  });
});
