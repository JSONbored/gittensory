import { afterEach, describe, expect, it, vi } from "vitest";
import * as signalTrackingWire from "../../src/review/signal-tracking-wire";
import { createSignalStore } from "../../src/review/signal-tracking-wire";
import * as repositories from "../../src/db/repositories";
import { listAuditEventsByType } from "../../src/db/repositories";
import { persistThresholdBacktestRuns, runThresholdBacktestAdvisory, THRESHOLD_BACKTEST_EVENT_TYPE } from "../../src/services/threshold-backtest-run";
import { createTestEnv } from "../helpers/d1";

afterEach(() => {
  vi.restoreAllMocks();
});

function diffFor(name: string, oldValue: string, newValue: string): string {
  return ["diff --git a/src/rules/advisory.ts b/src/rules/advisory.ts", "@@ -980,7 +980,7 @@", `-export const ${name} = ${oldValue};`, `+export const ${name} = ${newValue};`].join("\n");
}

describe("runThresholdBacktestAdvisory (#8138) — real D1 round-trip", () => {
  it("returns empty changed/comparisons when the diff touches no known threshold, without any D1 read", async () => {
    const env = createTestEnv();
    const result = await runThresholdBacktestAdvisory(env, "diff --git a/README.md b/README.md\n-old\n+new");
    expect(result).toEqual({ changed: [], comparisons: [] });
  });

  it("backtests a changed LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR against real recorded history", async () => {
    const env = createTestEnv();
    const now = Date.now();
    await createSignalStore(env).recordRuleFired({
      ruleId: "linked_issue_scope_mismatch",
      targetKey: "acme/widgets#1",
      outcome: "unaddressed",
      occurredAt: new Date(now - 1000).toISOString(),
      metadata: { confidence: 0.35 },
    });
    await createSignalStore(env).recordHumanOverride({
      ruleId: "linked_issue_scope_mismatch",
      targetKey: "acme/widgets#1",
      verdict: "reversed",
      occurredAt: new Date(now).toISOString(),
    });

    const result = await runThresholdBacktestAdvisory(env, diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "0.2"), now + 1000);
    expect(result.changed).toHaveLength(1);
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.ruleId).toBe("linked_issue_scope_mismatch");
    expect(result.comparisons[0]!.baseline.caseCount).toBe(1);
  });

  it("degrades to an empty corpus for a ruleId with no recorded history, rather than throwing", async () => {
    const env = createTestEnv();
    const result = await runThresholdBacktestAdvisory(env, diffFor("DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE", "0.93", "0.8"));
    expect(result.comparisons).toHaveLength(2);
    for (const comparison of result.comparisons) {
      expect(comparison.baseline.caseCount).toBe(0);
      expect(comparison.baseline.precision).toBeNull();
    }
  });

  it("degrades to an empty corpus (never throws) when the SignalStore read itself rejects", async () => {
    vi.spyOn(signalTrackingWire, "createSignalStore").mockReturnValue({
      recordRuleFired: vi.fn(),
      recordHumanOverride: vi.fn(),
      queryRuleHistory: vi.fn().mockRejectedValue(new Error("simulated D1 failure")),
    });
    const env = createTestEnv();
    const result = await runThresholdBacktestAdvisory(env, diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "0.4"));
    expect(result.comparisons).toHaveLength(1);
    expect(result.comparisons[0]!.baseline.caseCount).toBe(0);
    expect(result.comparisons[0]!.baseline.precision).toBeNull();
  });
});

describe("persistThresholdBacktestRuns (#8138) — real D1 round-trip", () => {
  it("records one audit_events row per (constant, ruleId) pair, readable back via listAuditEventsByType", async () => {
    const env = createTestEnv();
    const now = Date.now();
    const { changed, comparisons } = await runThresholdBacktestAdvisory(env, diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "0.4"), now);
    await persistThresholdBacktestRuns(env, "acme/widgets", 7, changed, comparisons);

    const rows = await listAuditEventsByType(env, THRESHOLD_BACKTEST_EVENT_TYPE, new Date(now - 60_000).toISOString());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetKey).toBe("acme/widgets#7");
    expect(rows[0]!.metadata.constantName).toBe("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR");
    expect((rows[0]!.metadata.comparison as { ruleId: string }).ruleId).toBe("linked_issue_scope_mismatch");
  });

  it("persists nothing when nothing changed", async () => {
    const env = createTestEnv();
    await persistThresholdBacktestRuns(env, "acme/widgets", 1, [], []);
    const rows = await listAuditEventsByType(env, THRESHOLD_BACKTEST_EVENT_TYPE, new Date(0).toISOString());
    expect(rows).toHaveLength(0);
  });

  it("skips a changed threshold with no matching comparison, rather than erroring (defensive guard for direct callers)", async () => {
    const env = createTestEnv();
    await persistThresholdBacktestRuns(
      env,
      "acme/widgets",
      1,
      [{ constantName: "LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", oldValue: 0.5, newValue: 0.4, ruleIds: ["linked_issue_scope_mismatch"] }],
      [], // no comparison for that ruleId
    );
    const rows = await listAuditEventsByType(env, THRESHOLD_BACKTEST_EVENT_TYPE, new Date(0).toISOString());
    expect(rows).toHaveLength(0);
  });

  it("degrades silently (never throws) when the recordAuditEvent write itself rejects", async () => {
    vi.spyOn(repositories, "recordAuditEvent").mockRejectedValue(new Error("simulated D1 write failure"));
    const env = createTestEnv();
    const now = Date.now();
    const { changed, comparisons } = await runThresholdBacktestAdvisory(env, diffFor("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "0.4"), now);
    await expect(persistThresholdBacktestRuns(env, "acme/widgets", 8, changed, comparisons)).resolves.toBeUndefined();
  });
});
