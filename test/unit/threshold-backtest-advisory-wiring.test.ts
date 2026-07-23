import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveThresholdBacktestAdvisory } from "../../src/queue/processors";
import { createSignalStore } from "../../src/review/signal-tracking-wire";
import { listAuditEventsByType } from "../../src/db/repositories";
import * as thresholdBacktestRun from "../../src/services/threshold-backtest-run";
import { THRESHOLD_BACKTEST_EVENT_TYPE } from "../../src/services/threshold-backtest-run";
import type { PullRequestFileRecord } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

afterEach(() => {
  vi.restoreAllMocks();
});

function fileRecord(path: string, patch: string, overrides: Partial<PullRequestFileRecord> = {}): PullRequestFileRecord {
  return { repoFullName: "acme/widgets", pullNumber: 7, path, status: "modified", additions: 1, deletions: 1, changes: 2, payload: { patch }, ...overrides };
}

function thresholdPatch(name: string, oldValue: string, newValue: string): string {
  return ["@@ -980,7 +980,7 @@", `-export const ${name} = ${oldValue};`, `+export const ${name} = ${newValue};`].join("\n");
}

describe("resolveThresholdBacktestAdvisory (processor wiring, #8138)", () => {
  it("returns '' without touching D1 at all when the PR doesn't touch either watched file", async () => {
    const env = createTestEnv();
    const files = [fileRecord("README.md", "@@ -1 +1 @@\n-old\n+new")];
    const result = await resolveThresholdBacktestAdvisory(env, "acme/widgets", { number: 7 }, files);
    expect(result).toBe("");
  });

  it("returns '' when the PR touches a watched file but doesn't actually change a known constant's value", async () => {
    const env = createTestEnv();
    const files = [fileRecord("src/rules/advisory.ts", "@@ -1 +1 @@\n-const unrelated = 1;\n+const unrelated = 2;")];
    const result = await resolveThresholdBacktestAdvisory(env, "acme/widgets", { number: 7 }, files);
    expect(result).toBe("");
  });

  it("renders a section and persists a run when the PR changes a known threshold, with real history behind it", async () => {
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

    const files = [fileRecord("src/services/linked-issue-satisfaction.ts", thresholdPatch("LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR", "0.5", "0.2"))];
    const result = await resolveThresholdBacktestAdvisory(env, "acme/widgets", { number: 7 }, files);

    expect(result).toContain("linked_issue_scope_mismatch");
    expect(result.length).toBeGreaterThan(0);

    const rows = await listAuditEventsByType(env, THRESHOLD_BACKTEST_EVENT_TYPE, new Date(now - 60_000).toISOString());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.targetKey).toBe("acme/widgets#7");
  });

  it("returns '' (and never throws) when the underlying backtest run itself rejects", async () => {
    // Reaches the try/catch's error path: give it a watched file so it proceeds past the cheap skip, then
    // force the D1-touching call to reject.
    vi.spyOn(thresholdBacktestRun, "runThresholdBacktestAdvisory").mockRejectedValue(new Error("simulated failure"));
    const env = createTestEnv();
    const files = [fileRecord("src/rules/advisory.ts", thresholdPatch("DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE", "0.93", "0.8"))];
    const result = await resolveThresholdBacktestAdvisory(env, "acme/widgets", { number: 7 }, files);
    expect(result).toBe("");
  });
});
