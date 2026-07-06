import { describe, expect, it } from "vitest";
import {
  deriveUnifiedStatus,
  LEGACY_FINDINGS_DISPLAY_CAP,
  renderUnifiedReviewComment,
  truncateDisplayedFindingLines,
  type UnifiedReviewInput,
} from "../../src/review/unified-comment";
import { buildUnifiedCommentBody } from "../../src/review/unified-comment-bridge";
import type { GateCheckEvaluation } from "../../src/rules/advisory";

const base: UnifiedReviewInput = {
  changedFiles: 2,
  reviewerCount: 1,
  recommendations: ["merge"],
  summary: "Looks good.",
};

function gate(over: Partial<GateCheckEvaluation> = {}): GateCheckEvaluation {
  return {
    enabled: true,
    conclusion: "success",
    title: "Gate passed",
    summary: "No blocker.",
    blockers: [],
    warnings: [],
    ...over,
  };
}

describe("truncateDisplayedFindingLines", () => {
  const lines = ["a", "b", "c", "d", "e"];

  it("returns all lines when cap is null", () => {
    expect(truncateDisplayedFindingLines(lines, null)).toEqual({ visible: lines, omitted: 0 });
  });

  it("returns all lines when under the cap", () => {
    expect(truncateDisplayedFindingLines(lines, 10)).toEqual({ visible: lines, omitted: 0 });
  });

  it("truncates at the cap and reports omitted count", () => {
    expect(truncateDisplayedFindingLines(lines, 3)).toEqual({ visible: ["a", "b", "c"], omitted: 2 });
  });

  it("handles a zero cap with a footer-eligible omission count", () => {
    expect(truncateDisplayedFindingLines(lines, 0)).toEqual({ visible: [], omitted: 5 });
  });
});

describe("renderUnifiedReviewComment max_findings display caps (#2049)", () => {
  it("keeps the legacy 12-nit cap when maxFindings is omitted (byte-identical)", () => {
    const md = renderUnifiedReviewComment(
      { ...base, nits: Array.from({ length: 13 }, (_, i) => `Distinct nit ${i + 1}`) },
      {},
    );
    expect(md).toContain("Distinct nit 12");
    expect(md).not.toContain("Distinct nit 13");
    expect(md).not.toContain("more nit(s) not shown");
    expect(LEGACY_FINDINGS_DISPLAY_CAP).toBe(12);
  });

  it("truncates nits with a +N more footer when maxFindings.nits is set", () => {
    const md = renderUnifiedReviewComment(
      { ...base, nits: ["nit one", "nit two", "nit three", "nit four"] },
      { maxFindings: { blockers: null, nits: 2 } },
    );
    expect(md).toContain("nit one");
    expect(md).toContain("nit two");
    expect(md).not.toContain("nit three");
    expect(md).toContain("_+2 more nit(s) not shown._");
    expect(md).toContain("2 non-blocking (+2 more)");
  });

  it("truncates blockers with a +N more footer when maxFindings.blockers is set", () => {
    const md = renderUnifiedReviewComment(
      { ...base, decision: "close", blockers: ["blocker A", "blocker B", "blocker C"] },
      { maxFindings: { blockers: 1, nits: null } },
    );
    expect(md).toContain("blocker A");
    expect(md).not.toContain("blocker B");
    expect(md).toContain("_+2 more blocker(s) not shown._");
  });

  it("shows all blockers when maxFindings.blockers is null inside a configured object", () => {
    const blockers = Array.from({ length: 15 }, (_, i) => `Blocker ${i + 1}`);
    const md = renderUnifiedReviewComment(
      { ...base, decision: "close", blockers },
      { maxFindings: { blockers: null, nits: 3 } },
    );
    expect(md).toContain("Blocker 15");
    expect(md).not.toContain("more blocker(s) not shown");
  });

  it("does not change gate-derived status when display lists are truncated", () => {
    const input: UnifiedReviewInput = {
      ...base,
      decision: "merge",
      readiness: { ciState: "passed" },
      blockers: Array.from({ length: 20 }, (_, i) => `Hidden blocker ${i + 1}`),
    };
    const withoutCap = deriveUnifiedStatus(input, {});
    const withCap = deriveUnifiedStatus(input, { maxFindings: { blockers: 1, nits: 1 } });
    expect(withoutCap).toBe("ready");
    expect(withCap).toBe("ready");
  });
});

describe("buildUnifiedCommentBody max_findings wiring (#2049)", () => {
  const footer = "footer";

  it("forwards maxFindings into the renderer when provided", () => {
    const notes = `Several nits.\n\n**Nits (4)**\n- nit 1\n- nit 2\n- nit 3\n- nit 4`;
    const body = buildUnifiedCommentBody({
      gate: gate(),
      aiReview: { notes },
      panelRows: [],
      readinessTotal: 80,
      changedFiles: 1,
      footerMarkdown: footer,
      maxFindings: { blockers: null, nits: 2 },
    });
    expect(body).toContain("nit 1");
    expect(body).toContain("nit 2");
    expect(body).not.toContain("nit 3");
    expect(body).toContain("_+2 more nit(s) not shown._");
  });

  it("omits maxFindings forwarding when the arg is absent (legacy cap)", () => {
    const nits = Array.from({ length: 13 }, (_, i) => `- legacy nit ${i + 1}`).join("\n");
    const notes = `Nits.\n\n**Nits (13)**\n${nits}`;
    const body = buildUnifiedCommentBody({
      gate: gate(),
      aiReview: { notes },
      panelRows: [],
      readinessTotal: 80,
      changedFiles: 1,
      footerMarkdown: footer,
    });
    expect(body).toContain("legacy nit 12");
    expect(body).not.toContain("legacy nit 13");
  });
});
