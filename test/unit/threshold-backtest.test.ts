import { describe, expect, it } from "vitest";
import type { BacktestCase } from "@loopover/engine";
import {
  backtestChangedThreshold,
  detectChangedThresholds,
  KNOWN_THRESHOLDS,
  thresholdBacktestBlock,
} from "../../src/services/threshold-backtest";

function diffFor(name: string, oldValue: string, newValue: string): string {
  return ["diff --git a/src/rules/advisory.ts b/src/rules/advisory.ts", "@@ -980,7 +980,7 @@", `-export const ${name} = ${oldValue};`, `+export const ${name} = ${newValue};`].join("\n");
}

function corpusCase(ruleId: string, targetKey: string, label: BacktestCase["label"], confidence: number): BacktestCase {
  return { ruleId, targetKey, outcome: "unaddressed", label, firedAt: "2026-07-22T00:00:00.000Z", decidedAt: "2026-07-22T01:00:00.000Z", metadata: { confidence } };
}

describe("detectChangedThresholds (#8138)", () => {
  it("detects a clean before/after pair for LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", () => {
    const changed = detectChangedThresholds(diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "0.4"));
    expect(changed).toEqual([
      { constantName: "LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", oldValue: 0.5, newValue: 0.4, ruleIds: ["linked_issue_scope_mismatch"] },
    ]);
  });

  it("detects DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE and maps it to both AI-judgment ruleIds", () => {
    const changed = detectChangedThresholds(diffFor("DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE", "0.93", "0.85"));
    expect(changed).toEqual([
      { constantName: "DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE", oldValue: 0.93, newValue: 0.85, ruleIds: ["ai_consensus_defect", "ai_review_split"] },
    ]);
  });

  it("ignores a diff that touches neither known constant", () => {
    expect(detectChangedThresholds(["diff --git a/README.md b/README.md", "-old line", "+new line"].join("\n"))).toEqual([]);
  });

  it("ignores an unrecognized constant name even in the same export-const shape", () => {
    expect(detectChangedThresholds(diffFor("SOME_OTHER_CONSTANT", "1", "2"))).toEqual([]);
  });

  it("skips a pair whose value didn't actually change (e.g. pure reformatting)", () => {
    expect(detectChangedThresholds(diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "0.5"))).toEqual([]);
  });

  it("skips an added-only constant (no old value to backtest against)", () => {
    const diff = ["diff --git a/src/rules/advisory.ts b/src/rules/advisory.ts", "@@ -980,6 +980,7 @@", "+export const LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR = 0.5;"].join("\n");
    expect(detectChangedThresholds(diff)).toEqual([]);
  });

  it("skips a removed-only constant (no new value to backtest)", () => {
    const diff = ["diff --git a/src/rules/advisory.ts b/src/rules/advisory.ts", "@@ -980,7 +980,6 @@", "-export const LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR = 0.5;"].join("\n");
    expect(detectChangedThresholds(diff)).toEqual([]);
  });

  it("skips a constant with more than one -/+ pair (ambiguous, not guessed at)", () => {
    const diff = [diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "0.4"), diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.6", "0.3")].join("\n");
    expect(detectChangedThresholds(diff)).toEqual([]);
  });

  it("skips a value that matches the digit/dot pattern but isn't a real finite number (e.g. multiple dots)", () => {
    expect(detectChangedThresholds(diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "1.2.3"))).toEqual([]);
  });

  it("every KNOWN_THRESHOLDS entry maps to at least one ruleId", () => {
    for (const name of Object.keys(KNOWN_THRESHOLDS)) {
      expect(KNOWN_THRESHOLDS[name]!.ruleIds.length).toBeGreaterThan(0);
    }
  });
});

describe("backtestChangedThreshold (#8138)", () => {
  it("scores each ruleId in the change against its own corpus slice", () => {
    const change = { constantName: "DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE", oldValue: 0.93, newValue: 0.8, ruleIds: ["ai_consensus_defect", "ai_review_split"] };
    const corpusByRuleId = new Map([
      ["ai_consensus_defect", [corpusCase("ai_consensus_defect", "a#1", "confirmed", 0.95)]],
      ["ai_review_split", [corpusCase("ai_review_split", "a#2", "confirmed", 0.95)]],
    ]);
    const comparisons = backtestChangedThreshold(change, corpusByRuleId);
    expect(comparisons).toHaveLength(2);
    expect(comparisons.map((c) => c.ruleId).sort()).toEqual(["ai_consensus_defect", "ai_review_split"]);
  });

  it("scores an empty corpus (missing ruleId entry) as all-null rather than throwing", () => {
    const change = { constantName: "LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", oldValue: 0.5, newValue: 0.4, ruleIds: ["linked_issue_scope_mismatch"] };
    const comparisons = backtestChangedThreshold(change, new Map());
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]!.baseline.precision).toBeNull();
  });
});

describe("thresholdBacktestBlock (#8138)", () => {
  it("returns an empty string for zero comparisons, mirroring unified-comment.ts's own xxxBlock convention", () => {
    expect(thresholdBacktestBlock([])).toBe("");
  });

  it("renders every comparison, joined, when at least one is present", () => {
    const change = { constantName: "LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", oldValue: 0.5, newValue: 0.2, ruleIds: ["linked_issue_scope_mismatch"] };
    const corpusByRuleId = new Map([["linked_issue_scope_mismatch", [corpusCase("linked_issue_scope_mismatch", "a#1", "reversed", 0.35)]]]);
    const block = thresholdBacktestBlock(backtestChangedThreshold(change, corpusByRuleId));
    expect(block).toContain("linked_issue_scope_mismatch");
    expect(block.length).toBeGreaterThan(0);
  });
});
