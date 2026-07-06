import { describe, expect, it, vi } from "vitest";
import {
  buildUnifiedCommentBody,
  deriveAutoMergeConditionsFromSignals,
} from "../../src/review/unified-comment-bridge";
import * as unifiedComment from "../../src/review/unified-comment";
import type { GateCheckEvaluation } from "../../src/rules/advisory";
import type { PublicPrPanelSignalRow } from "../../src/signals/engine";

function gate(over: Partial<GateCheckEvaluation> = {}): GateCheckEvaluation {
  return {
    enabled: true,
    conclusion: "success",
    title: "Gittensory Orb Review Agent passed",
    summary: "No configured hard blocker was found.",
    blockers: [],
    warnings: [],
    ...over,
  };
}

const panelRowsPassing: PublicPrPanelSignalRow[] = [
  { key: "linkedIssue", cells: ["Linked issue", "✅ Linked", "#42", "No action."] },
  { key: "gateResult", cells: ["Gate result", "✅ Passing", "No configured blocker found.", "No action."] },
];

const footer = "💰 Earn for open-source contributions. Checked by Gittensory.";

describe("buildAutoMergeSummaryCollapsible", () => {
  it("renders a four-row read-only conditions table", () => {
    const conditions = deriveAutoMergeConditionsFromSignals({
      gate: gate(),
      mergeReadiness: { ciState: "passed", mergeStateLabel: "clean" },
      panelRows: panelRowsPassing,
    });
    const c = unifiedComment.buildAutoMergeSummaryCollapsible(conditions);
    expect(c).not.toBeNull();
    expect(c?.title).toBe("Auto-merge conditions");
    expect(c?.body).toContain("| Condition | Status | Evidence |");
    expect(c?.body).toContain("| CI green | ✅ |");
    expect(c?.body).toContain("| Gate passing | ✅ |");
    expect(c?.body).toContain("| Mergeable / clean | ✅ |");
    expect(c?.body).toContain("| Valid linked issue | ✅ |");
    expect(c?.body).toContain("Does not change the merge decision");
  });

  it("returns null for an empty condition list", () => {
    expect(unifiedComment.buildAutoMergeSummaryCollapsible([])).toBeNull();
  });
});

describe("deriveAutoMergeConditionsFromSignals", () => {
  it("maps failing CI, gate failure, dirty merge state, and missing linked issue to fail/warn states", () => {
    const rows = deriveAutoMergeConditionsFromSignals({
      gate: gate({ conclusion: "failure" }),
      mergeReadiness: {
        ciState: "failed",
        mergeStateLabel: "dirty",
        failingChecks: ["codecov/patch"],
      },
      panelRows: [
        { key: "linkedIssue", cells: ["Linked issue", "⚠️ Missing", "No linked issue or no-issue rationale found.", "Explain no-issue PR."] },
        { key: "gateResult", cells: ["Gate result", "❌ Blocking", "Repo-configured hard blocker found.", "Fix blocker."] },
      ],
    });
    expect(rows.map((row) => row.state)).toEqual(["fail", "fail", "fail", "warn"]);
    expect(rows[0]?.evidence).toContain("codecov/patch");
    expect(rows[2]?.evidence).toContain("dirty");
  });

  it("falls back to gate fields when the gateResult panel row is absent", () => {
    const rows = deriveAutoMergeConditionsFromSignals({
      gate: gate({ enabled: false, conclusion: "skipped" }),
      mergeReadiness: { ciState: "unverified" },
      panelRows: [],
    });
    expect(rows.find((row) => row.condition === "Gate passing")?.state).toBe("warn");
    expect(rows.find((row) => row.condition === "CI green")?.state).toBe("warn");
    expect(rows.find((row) => row.condition === "Mergeable / clean")?.state).toBe("warn");
    expect(rows.find((row) => row.condition === "Valid linked issue")?.state).toBe("warn");
  });

  it("marks only an explicit clean merge state as ok — blocked/unstable/draft stay warn (#2051)", () => {
    for (const label of ["blocked", "unstable", "unmergeable", "draft", "unknown"]) {
      const rows = deriveAutoMergeConditionsFromSignals({
        gate: gate(),
        mergeReadiness: { ciState: "passed", mergeStateLabel: label },
        panelRows: panelRowsPassing,
      });
      expect(rows.find((row) => row.condition === "Mergeable / clean")?.state).toBe("warn");
    }
    const clean = deriveAutoMergeConditionsFromSignals({
      gate: gate(),
      mergeReadiness: { ciState: "passed", mergeStateLabel: "clean" },
      panelRows: panelRowsPassing,
    });
    expect(clean.find((row) => row.condition === "Mergeable / clean")?.state).toBe("ok");
    const dirty = deriveAutoMergeConditionsFromSignals({
      gate: gate(),
      mergeReadiness: { ciState: "passed", mergeStateLabel: "dirty" },
      panelRows: panelRowsPassing,
    });
    expect(dirty.find((row) => row.condition === "Mergeable / clean")?.state).toBe("fail");
  });

  it("does not invoke deriveUnifiedStatus — display-only derivation from pre-computed signals (#2051)", () => {
    const spy = vi.spyOn(unifiedComment, "deriveUnifiedStatus");
    deriveAutoMergeConditionsFromSignals({
      gate: gate(),
      mergeReadiness: { ciState: "passed", mergeStateLabel: "clean" },
      panelRows: panelRowsPassing,
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("covers gate fallback arms when the gateResult panel row is absent (#2051 codecov)", () => {
    const success = deriveAutoMergeConditionsFromSignals({
      gate: gate({ enabled: true, conclusion: "success" }),
      panelRows: [],
    }).find((row) => row.condition === "Gate passing");
    expect(success?.state).toBe("ok");
    expect(success?.evidence).toContain("No configured hard blocker");

    const failure = deriveAutoMergeConditionsFromSignals({
      gate: gate({ enabled: true, conclusion: "failure" }),
      panelRows: [],
    }).find((row) => row.condition === "Gate passing");
    expect(failure?.state).toBe("fail");

    const actionRequired = deriveAutoMergeConditionsFromSignals({
      gate: gate({ enabled: true, conclusion: "action_required" }),
      panelRows: [],
    }).find((row) => row.condition === "Gate passing");
    expect(actionRequired?.state).toBe("warn");
    expect(actionRequired?.evidence).toContain("Install/config needs attention");

    const neutral = deriveAutoMergeConditionsFromSignals({
      gate: gate({ enabled: true, conclusion: "neutral" }),
      panelRows: [],
    }).find((row) => row.condition === "Gate passing");
    expect(neutral?.state).toBe("warn");
    expect(neutral?.evidence).toBe("Gate is not blocking this PR.");

    const skipped = deriveAutoMergeConditionsFromSignals({
      gate: gate({ enabled: true, conclusion: "skipped" }),
      panelRows: [],
    }).find((row) => row.condition === "Gate passing");
    expect(skipped?.state).toBe("warn");
    expect(skipped?.evidence).toBe("Gate is not blocking this PR.");
  });

  it("covers CI failed without failingChecks, absent ciState, and behind merge state (#2051 codecov)", () => {
    const failed = deriveAutoMergeConditionsFromSignals({
      gate: gate(),
      mergeReadiness: { ciState: "failed", mergeStateLabel: "behind" },
      panelRows: panelRowsPassing,
    });
    expect(failed.find((row) => row.condition === "CI green")?.evidence).toBe("CI checks are failing.");
    expect(failed.find((row) => row.condition === "Mergeable / clean")?.state).toBe("fail");

    const unresolvedCi = deriveAutoMergeConditionsFromSignals({
      gate: gate(),
      mergeReadiness: {},
      panelRows: panelRowsPassing,
    });
    expect(unresolvedCi.find((row) => row.condition === "CI green")?.evidence).toBe("CI state was not resolved.");
  });

  it("reads warn/fail states from gateResult and linkedIssue panel rows (#2051 codecov)", () => {
    const rows = deriveAutoMergeConditionsFromSignals({
      gate: gate(),
      mergeReadiness: { ciState: "passed", mergeStateLabel: "clean" },
      panelRows: [
        { key: "gateResult", cells: ["Gate result", "⚠️ Advisory only", "Advisory only.", "No action."] },
        { key: "linkedIssue", cells: ["Linked issue", "❌ Missing", "No linked issue.", "Explain."] },
      ],
    });
    expect(rows.find((row) => row.condition === "Gate passing")?.state).toBe("warn");
    expect(rows.find((row) => row.condition === "Valid linked issue")?.state).toBe("fail");
  });

  it("formats panel evidence from result-only, detail-only, combined, and empty cells (#2051 codecov)", () => {
    const combined = deriveAutoMergeConditionsFromSignals({
      gate: gate(),
      mergeReadiness: { ciState: "passed", mergeStateLabel: "clean" },
      panelRows: [{ key: "linkedIssue", cells: ["Linked issue", "✅ Linked", "#42", "No action."] }],
    });
    expect(combined.find((row) => row.condition === "Valid linked issue")?.evidence).toContain("Linked — #42");

    const resultOnly = deriveAutoMergeConditionsFromSignals({
      gate: gate(),
      panelRows: [{ key: "linkedIssue", cells: ["Linked issue", "✅ Linked", "", "No action."] }],
    });
    expect(resultOnly.find((row) => row.condition === "Valid linked issue")?.evidence).toBe("Linked");

    const detailOnly = deriveAutoMergeConditionsFromSignals({
      gate: gate(),
      panelRows: [{ key: "linkedIssue", cells: ["Linked issue", "", "No linked issue context.", "Explain."] }],
    });
    expect(detailOnly.find((row) => row.condition === "Valid linked issue")?.evidence).toBe("No linked issue context.");

    const empty = deriveAutoMergeConditionsFromSignals({
      gate: gate(),
      panelRows: [{ key: "linkedIssue", cells: ["Linked issue", "", "", "No action."] }],
    });
    expect(empty.find((row) => row.condition === "Valid linked issue")?.evidence).toBe("No details.");
  });
});

describe("buildUnifiedCommentBody autoMergeSummary wiring (#2051)", () => {
  const base = {
    gate: gate(),
    panelRows: panelRowsPassing,
    readinessTotal: 90,
    changedFiles: 2,
    mergeReadiness: { ciState: "passed" as const, mergeStateLabel: "clean" },
    footerMarkdown: footer,
  };

  it("appends the Auto-merge conditions section when autoMergeSummary is on", () => {
    const body = buildUnifiedCommentBody({ ...base, autoMergeSummary: true });
    expect(body).toContain("Auto-merge conditions");
    expect(body).toContain("| CI green | ✅ |");
    expect(body).toContain("| Valid linked issue | ✅ |");
  });

  it("does NOT add the section when autoMergeSummary is absent (flag-OFF parity)", () => {
    const body = buildUnifiedCommentBody(base);
    expect(body).not.toContain("Auto-merge conditions");
  });

  it("preserves pre-existing extraCollapsibles when autoMergeSummary is off (#2051 codecov)", () => {
    const body = buildUnifiedCommentBody({
      ...base,
      extraCollapsibles: [{ title: "Signal definitions", body: "what each row means" }],
    });
    expect(body).not.toContain("Auto-merge conditions");
    expect(body).toContain("Signal definitions");
  });

  it("appends only the auto-merge section when no other optional collapsibles are present (#2051 codecov)", () => {
    const body = buildUnifiedCommentBody({ ...base, autoMergeSummary: true });
    expect(body).toContain("Auto-merge conditions");
    expect(body).not.toContain("Changed files");
    expect(body).not.toContain("Visual preview");
  });

  it("coexists with Changed files and Visual preview collapsibles", () => {
    const body = buildUnifiedCommentBody({
      ...base,
      autoMergeSummary: true,
      changedFilesSummary: [{ path: "src/app.ts", additions: 1, deletions: 0 }],
      beforeAfter: [{ path: "/", afterUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/x.png" }],
    });
    expect(body).toContain("Auto-merge conditions");
    expect(body).toContain("Changed files");
    expect(body).toContain("Visual preview");
    expect(body.indexOf("Auto-merge conditions")).toBeLessThan(body.indexOf("Changed files"));
  });
});
