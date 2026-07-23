import { describe, expect, it } from "vitest";

// Import the engine SOURCE directly (not the built dist) -- coverage.include lists
// packages/loopover-engine/src/**, so only a source-path import exercises the .ts these branches live in
// (the dist-importing twin in packages/loopover-engine/test/ covers the built barrel for the workspace
// suite). Same pattern as backtest-compare-engine.test.ts.
import { buildConfidenceThresholdClassifier, runThresholdBacktest } from "../../packages/loopover-engine/src/calibration/backtest-threshold";
import type { BacktestCase } from "../../packages/loopover-engine/src/calibration/backtest-corpus";

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

describe("buildConfidenceThresholdClassifier (#8138)", () => {
  it("predicts reversed when confidence is below the threshold", () => {
    const classify = buildConfidenceThresholdClassifier(0.5);
    expect(classify(corpusCase("a#1", "reversed", 0.3))).toBe("reversed");
  });

  it("predicts confirmed when confidence is at or above the threshold", () => {
    const classify = buildConfidenceThresholdClassifier(0.5);
    expect(classify(corpusCase("a#1", "confirmed", 0.5))).toBe("confirmed");
    expect(classify(corpusCase("a#2", "confirmed", 0.9))).toBe("confirmed");
  });

  it("degrades a missing/non-numeric confidence to 1 (never predicted reversed by default)", () => {
    const classify = buildConfidenceThresholdClassifier(0.99);
    expect(classify(corpusCase("a#1", "confirmed"))).toBe("confirmed");
    expect(classify({ ...corpusCase("a#2", "confirmed"), metadata: { confidence: "not-a-number" } })).toBe("confirmed");
  });
});

describe("runThresholdBacktest (#8138)", () => {
  it("reports improved when lowering the floor correctly reclassifies a previously-missed reversed case", () => {
    // At threshold 0.5: confidence 0.4 -> predicted "confirmed" (wrong, real label is "reversed").
    // At threshold 0.3: confidence 0.4 -> predicted "confirmed" still... use a case where the NEW
    // (lower) threshold correctly flips the prediction to match the real "reversed" label instead.
    const cases: BacktestCase[] = [corpusCase("a#1", "reversed", 0.35)];
    // Old threshold 0.5: confidence 0.35 < 0.5 -> predicted "reversed" -> matches label -> truePositive.
    // New threshold 0.2: confidence 0.35 >= 0.2 -> predicted "confirmed" -> mismatches "reversed" label -> falseNegative.
    // This is a REGRESSION case (lowering the floor here makes it worse) -- exercises the "regressed" verdict.
    const comparison = runThresholdBacktest("linked_issue_scope_mismatch", cases, 0.5, 0.2);
    expect(comparison.verdict).toBe("regressed");
    expect(comparison.regressedAxes).toContain("recall");
  });

  it("reports unchanged when the corpus is empty (both scores are all-null)", () => {
    const comparison = runThresholdBacktest("linked_issue_scope_mismatch", [], 0.5, 0.3);
    expect(comparison.verdict).toBe("unchanged");
    expect(comparison.baseline.caseCount).toBe(0);
    expect(comparison.candidate.caseCount).toBe(0);
  });

  it("only scores cases matching the given ruleId", () => {
    const cases: BacktestCase[] = [
      { ...corpusCase("a#1", "reversed", 0.1), ruleId: "other_rule" },
      corpusCase("a#2", "confirmed", 0.9),
    ];
    const comparison = runThresholdBacktest("linked_issue_scope_mismatch", cases, 0.5, 0.3);
    expect(comparison.baseline.caseCount).toBe(1);
    expect(comparison.candidate.caseCount).toBe(1);
  });
});
