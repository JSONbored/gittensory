import { describe, expect, it } from "vitest";
import {
  buildAutoMergeSummaryCollapsible,
  buildUnifiedCommentBody,
  deriveAutoMergeSummaryInput,
} from "../../src/review/unified-comment-bridge";
import type { GateCheckEvaluation } from "../../src/rules/advisory";
import type { PublicPrPanelSignalRow } from "../../src/signals/engine";
import type { MergeReadiness } from "../../src/review/unified-comment";

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

const footer = "💰 Earn for open-source contributions. Checked by Gittensory.";

const panelRowsAllPass: PublicPrPanelSignalRow[] = [
  { key: "linkedIssue", cells: ["Linked issue", "✅ Linked", "#42", "None."] },
  { key: "gateResult", cells: ["Gate result", "✅ Passing", "No configured blocker found.", "No action."] },
];

const mergeReadinessPass: MergeReadiness = { ciState: "passed", mergeStateLabel: "clean" };

describe("deriveAutoMergeSummaryInput / buildAutoMergeSummaryCollapsible (#2051)", () => {
  it("marks all four conditions pass when signals are green", () => {
    expect(
      deriveAutoMergeSummaryInput({
        mergeReadiness: mergeReadinessPass,
        gateConclusion: "success",
        panelRows: panelRowsAllPass,
      }),
    ).toEqual({ ciGreen: true, gatePassing: true, mergeableClean: true, linkedIssueOk: true });
    const c = buildAutoMergeSummaryCollapsible({
      ciGreen: true,
      gatePassing: true,
      mergeableClean: true,
      linkedIssueOk: true,
    });
    expect(c.title).toBe("Auto-merge conditions");
    expect(c.body).toContain("✅ pass");
    expect(c.body).not.toContain("❌ fail");
    expect(c.body).toContain("Read-only");
  });

  it("marks failures for red CI, non-success gate, dirty merge state, and missing linked issue", () => {
    expect(
      deriveAutoMergeSummaryInput({
        mergeReadiness: { ciState: "failed", mergeStateLabel: "dirty" },
        gateConclusion: "failure",
        panelRows: [{ key: "linkedIssue", cells: ["Linked issue", "❌ Missing", "None", "Link one."] }],
      }),
    ).toEqual({ ciGreen: false, gatePassing: false, mergeableClean: false, linkedIssueOk: false });
    const c = buildAutoMergeSummaryCollapsible({
      ciGreen: false,
      gatePassing: false,
      mergeableClean: false,
      linkedIssueOk: false,
    });
    expect(c.body.match(/❌ fail/g)?.length).toBe(4);
  });

  it("treats absent merge state and linked-issue row as failing", () => {
    expect(
      deriveAutoMergeSummaryInput({
        gateConclusion: "success",
        panelRows: [],
      }),
    ).toEqual({ ciGreen: false, gatePassing: true, mergeableClean: false, linkedIssueOk: false });
  });

  it("marks linked issue failing when the row exists but is not green", () => {
    expect(
      deriveAutoMergeSummaryInput({
        mergeReadiness: mergeReadinessPass,
        gateConclusion: "success",
        panelRows: [{ key: "linkedIssue", cells: ["Linked issue", "⚠️ Preferred", "#42", "Link one."] }],
      }),
    ).toEqual({ ciGreen: true, gatePassing: true, mergeableClean: true, linkedIssueOk: false });
  });

  it("treats missing mergeStateLabel as not mergeable-clean", () => {
    expect(
      deriveAutoMergeSummaryInput({
        mergeReadiness: { ciState: "passed" },
        gateConclusion: "success",
        panelRows: panelRowsAllPass,
      }),
    ).toEqual({ ciGreen: true, gatePassing: true, mergeableClean: false, linkedIssueOk: true });
  });
});

describe("buildUnifiedCommentBody auto_merge_summary wiring (#2051)", () => {
  it("renders the Auto-merge conditions section when enabled and omits it otherwise", () => {
    const baseArgs = {
      gate: gate(),
      aiReview: { notes: "Clean change." },
      panelRows: panelRowsAllPass,
      readinessTotal: 88,
      changedFiles: 1,
      footerMarkdown: footer,
      mergeReadiness: mergeReadinessPass,
    };
    const withSummary = buildUnifiedCommentBody({ ...baseArgs, autoMergeSummary: true });
    expect(withSummary).toContain("Auto-merge conditions");
    expect(withSummary).toContain("| CI green | ✅ pass |");
    const withoutSummary = buildUnifiedCommentBody(baseArgs);
    expect(withoutSummary).not.toContain("Auto-merge conditions");
    expect(buildUnifiedCommentBody({ ...baseArgs, autoMergeSummary: false })).not.toContain("Auto-merge conditions");
  });

  it("derives auto-merge conditions without mergeReadiness when the caller omits it (#2051)", () => {
    const body = buildUnifiedCommentBody({
      gate: gate(),
      aiReview: { notes: "Clean change." },
      panelRows: panelRowsAllPass,
      readinessTotal: 88,
      changedFiles: 1,
      footerMarkdown: footer,
      autoMergeSummary: true,
    });
    expect(body).toContain("Auto-merge conditions");
    expect(body).toContain("| CI green | ❌ fail |");
  });

  it("coexists with the Visual preview section when both are enabled (#2051)", () => {
    const body = buildUnifiedCommentBody({
      gate: gate(),
      aiReview: { notes: "Clean change." },
      panelRows: panelRowsAllPass,
      readinessTotal: 88,
      changedFiles: 1,
      footerMarkdown: footer,
      mergeReadiness: mergeReadinessPass,
      autoMergeSummary: true,
      beforeAfter: [{ path: "/", afterUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/x.png" }],
    });
    expect(body).toContain("Auto-merge conditions");
    expect(body).toContain("Visual preview");
  });

  it("renders Visual preview without auto-merge when only beforeAfter is set (#2051)", () => {
    const body = buildUnifiedCommentBody({
      gate: gate(),
      aiReview: { notes: "Clean change." },
      panelRows: panelRowsAllPass,
      readinessTotal: 88,
      changedFiles: 1,
      footerMarkdown: footer,
      beforeAfter: [{ path: "/", afterUrl: "https://api.example.dev/gittensory/shot?key=gittensory/shots/x.png" }],
    });
    expect(body).toContain("Visual preview");
    expect(body).not.toContain("Auto-merge conditions");
  });
});
