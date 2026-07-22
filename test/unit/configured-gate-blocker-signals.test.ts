import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordConfiguredGateBlockerSignals,
  type GateCheckPolicy,
} from "../../src/rules/advisory";
import * as signalTrackingWire from "../../src/review/signal-tracking-wire";
import { createSignalStore } from "../../src/review/signal-tracking-wire";
import type { Advisory, AdvisoryFinding } from "../../src/types";
import { createTestEnv } from "../helpers/d1";

function finding(over: Partial<AdvisoryFinding> & Pick<AdvisoryFinding, "code">): AdvisoryFinding {
  return {
    title: over.title ?? over.code,
    severity: over.severity ?? "warning",
    detail: over.detail ?? `${over.code} detail`,
    action: over.action ?? "fix it",
    ...over,
  };
}

function advisory(findings: AdvisoryFinding[]): Advisory {
  return {
    id: "advisory-8104",
    targetType: "pull_request",
    targetKey: "owner/repo#7",
    repoFullName: "owner/repo",
    pullNumber: 7,
    headSha: "abc",
    conclusion: "neutral",
    severity: "warning",
    title: "advisory",
    summary: `${findings.length} finding(s)`,
    findings,
    generatedAt: "2026-07-22T00:00:00.000Z",
  };
}

const blockAi: GateCheckPolicy = { aiReviewGateMode: "block" };
const blockLinked: GateCheckPolicy = { linkedIssueGateMode: "block" };
const blockSatisfaction: GateCheckPolicy = { linkedIssueSatisfactionGateMode: "block" };

describe("recordConfiguredGateBlockerSignals (#8104)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("records a fired signal for ai_consensus_defect when it is a configured gate blocker", async () => {
    const env = createTestEnv();
    await recordConfiguredGateBlockerSignals(
      env,
      advisory([finding({ code: "ai_consensus_defect", confidence: 0.95 })]),
      blockAi,
      "owner/repo",
      7,
    );
    const history = await createSignalStore(env).queryRuleHistory("ai_consensus_defect", 0);
    expect(history.fired).toHaveLength(1);
    expect(history.fired[0]).toMatchObject({
      ruleId: "ai_consensus_defect",
      targetKey: "owner/repo#7",
      outcome: "warning",
      metadata: { confidence: 0.95 },
    });
  });

  it("records a fired signal for ai_review_split when it is a configured gate blocker", async () => {
    const env = createTestEnv();
    await recordConfiguredGateBlockerSignals(
      env,
      advisory([finding({ code: "ai_review_split", severity: "critical" })]),
      blockAi,
      "owner/repo",
      7,
    );
    const history = await createSignalStore(env).queryRuleHistory("ai_review_split", 0);
    expect(history.fired).toHaveLength(1);
    expect(history.fired[0]).toMatchObject({
      ruleId: "ai_review_split",
      targetKey: "owner/repo#7",
      outcome: "critical",
    });
    expect(history.fired[0]?.metadata).toBeUndefined();
  });

  it("records a fired signal for a deterministic code (secret_leak)", async () => {
    const env = createTestEnv();
    await recordConfiguredGateBlockerSignals(
      env,
      advisory([finding({ code: "secret_leak", severity: "critical" })]),
      {},
      "owner/repo",
      7,
    );
    const history = await createSignalStore(env).queryRuleHistory("secret_leak", 0);
    expect(history.fired).toHaveLength(1);
    expect(history.fired[0]).toMatchObject({
      ruleId: "secret_leak",
      targetKey: "owner/repo#7",
      outcome: "critical",
    });
  });

  it("records a fired signal for missing_linked_issue when linkedIssueGateMode is block", async () => {
    const env = createTestEnv();
    await recordConfiguredGateBlockerSignals(
      env,
      advisory([finding({ code: "missing_linked_issue" })]),
      blockLinked,
      "owner/repo",
      7,
    );
    expect((await createSignalStore(env).queryRuleHistory("missing_linked_issue", 0)).fired).toHaveLength(1);
  });

  it("records NO fired signal for linked_issue_scope_mismatch even when it is a configured blocker (#8101 owns it)", async () => {
    const env = createTestEnv();
    await recordConfiguredGateBlockerSignals(
      env,
      advisory([finding({ code: "linked_issue_scope_mismatch" }), finding({ code: "secret_leak", severity: "critical" })]),
      blockSatisfaction,
      "owner/repo",
      7,
    );
    expect((await createSignalStore(env).queryRuleHistory("linked_issue_scope_mismatch", 0)).fired).toEqual([]);
    expect((await createSignalStore(env).queryRuleHistory("secret_leak", 0)).fired).toHaveLength(1);
  });

  it("records NO fired signal when isConfiguredGateBlocker returns false", async () => {
    const env = createTestEnv();
    // missing_linked_issue defaults to advisory — not a configured blocker.
    await recordConfiguredGateBlockerSignals(
      env,
      advisory([finding({ code: "missing_linked_issue" })]),
      { linkedIssueGateMode: "advisory" },
      "owner/repo",
      7,
    );
    expect((await createSignalStore(env).queryRuleHistory("missing_linked_issue", 0)).fired).toEqual([]);
  });

  it("uses outcome 'blocker' when finding.severity is missing (nullish coalescing arm)", async () => {
    const env = createTestEnv();
    const noSeverity = finding({ code: "secret_leak" });
    delete (noSeverity as { severity?: AdvisoryFinding["severity"] }).severity;
    await recordConfiguredGateBlockerSignals(env, advisory([noSeverity]), {}, "owner/repo", 7);
    expect((await createSignalStore(env).queryRuleHistory("secret_leak", 0)).fired[0]?.outcome).toBe("blocker");
  });

  it("degrades silently when the SignalStore write rejects: nothing throws", async () => {
    vi.spyOn(signalTrackingWire, "createSignalStore").mockReturnValue({
      recordRuleFired: async () => {
        throw new Error("signal store down");
      },
      recordHumanOverride: async () => undefined,
      queryRuleHistory: async () => ({ fired: [], overrides: [] }),
    });
    await expect(
      recordConfiguredGateBlockerSignals(
        createTestEnv(),
        advisory([finding({ code: "secret_leak", severity: "critical" })]),
        {},
        "owner/repo",
        7,
      ),
    ).resolves.toBeUndefined();
  });
});
