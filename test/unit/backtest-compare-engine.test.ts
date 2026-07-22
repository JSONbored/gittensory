import { describe, expect, it } from "vitest";

// Import the engine SOURCE directly (not the built dist) -- coverage.include lists
// packages/loopover-engine/src/**, so only a source-path import exercises the .ts these branches live in
// (the dist-importing twin in packages/loopover-engine/test/ covers the built barrel for the workspace
// suite). Same pattern as backtest-corpus-engine.test.ts / miner-deny-hook-synthesis.test.ts.
import { compareBacktestScores } from "../../packages/loopover-engine/src/calibration/backtest-compare";
import type { BacktestScoreReport } from "../../packages/loopover-engine/src/calibration/backtest-score";

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

describe("compareBacktestScores (#8086)", () => {
  it("marks both-axes improvement as improved with empty regressedAxes", () => {
    const comparison = compareBacktestScores(report(), report({ precision: 0.7, recall: 0.6 }));
    expect(comparison.improvedAxes).toEqual(["precision", "recall"]);
    expect(comparison.regressedAxes).toEqual([]);
    expect(comparison.verdict).toBe("improved");
    expect(comparison.baseline.precision).toBe(0.5);
    expect(comparison.candidate.precision).toBe(0.7);
  });

  it("PARETO FLOOR: one axis improving while the other regresses is a regressed verdict", () => {
    const comparison = compareBacktestScores(report(), report({ precision: 0.9, recall: 0.3 }));
    expect(comparison.improvedAxes).toEqual(["precision"]);
    expect(comparison.regressedAxes).toEqual(["recall"]);
    expect(comparison.verdict).toBe("regressed");
  });

  it("marks a regression on both axes as regressed with empty improvedAxes", () => {
    const comparison = compareBacktestScores(report(), report({ precision: 0.1, recall: 0.2 }));
    expect(comparison.regressedAxes).toEqual(["precision", "recall"]);
    expect(comparison.improvedAxes).toEqual([]);
    expect(comparison.verdict).toBe("regressed");
  });

  it("excludes an axis from both lists when either side is null -- null is never 0 and never 'no change'", () => {
    const nullBaseline = compareBacktestScores(report({ precision: null }), report({ precision: 0.9, recall: 0.6 }));
    expect(nullBaseline.improvedAxes).toEqual(["recall"]);
    expect(nullBaseline.regressedAxes).toEqual([]);
    expect(nullBaseline.verdict).toBe("improved");

    const nullCandidate = compareBacktestScores(report(), report({ recall: null }));
    expect(nullCandidate.improvedAxes).toEqual([]);
    expect(nullCandidate.regressedAxes).toEqual([]);
    expect(nullCandidate.verdict).toBe("unchanged");
  });

  it("yields unchanged when every comparable axis is equal", () => {
    const comparison = compareBacktestScores(report(), report());
    expect(comparison.improvedAxes).toEqual([]);
    expect(comparison.regressedAxes).toEqual([]);
    expect(comparison.verdict).toBe("unchanged");
    expect(comparison.ruleId).toBe("missing_linked_issue");
  });

  it("throws on mismatched ruleIds, naming both rules in the message", () => {
    expect(() => compareBacktestScores(report(), report({ ruleId: "other_rule" }))).toThrow(
      "cannot compare backtest scores for different rules: missing_linked_issue vs other_rule",
    );
  });
});
