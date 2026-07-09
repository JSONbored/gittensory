import { describe, expect, it } from "vitest";
import {
  buildFindingCategoryCounts,
  buildStructuredAiReviewFindings,
  INLINE_FINDINGS_METADATA_KEY,
  parseStoredInlineFindings,
} from "../../src/mcp/pr-ai-review-findings";
import { buildFindingCategoryCollapsible } from "../../src/review/unified-comment-bridge";
import type { InlineFinding } from "../../src/services/ai-review";

const sampleFindings: InlineFinding[] = [
  { path: "src/db.ts", line: 12, severity: "blocker", body: "This is vulnerable to SQL injection.", category: "security" },
  { path: "src/util.ts", line: 4, severity: "nit", body: "This will throw on an empty array." },
  { path: "src/app.test.ts", line: 9, severity: "blocker", body: "Assert the right value here." },
];

describe("parseStoredInlineFindings", () => {
  it("returns an empty list when metadata is absent or malformed", () => {
    expect(parseStoredInlineFindings(undefined)).toEqual([]);
    expect(parseStoredInlineFindings({})).toEqual([]);
    expect(parseStoredInlineFindings({ [INLINE_FINDINGS_METADATA_KEY]: "nope" })).toEqual([]);
    expect(parseStoredInlineFindings({ [INLINE_FINDINGS_METADATA_KEY]: [{ path: "", line: 1, severity: "nit", body: "x" }] })).toEqual([]);
    expect(parseStoredInlineFindings({ [INLINE_FINDINGS_METADATA_KEY]: [{ path: "a.ts", line: 0, severity: "nit", body: "x" }] })).toEqual([]);
    expect(parseStoredInlineFindings({ [INLINE_FINDINGS_METADATA_KEY]: [{ path: "a.ts", line: 1, severity: "maybe", body: "x" }] })).toEqual([]);
  });

  it("keeps valid inline findings and drops invalid category values", () => {
    const parsed = parseStoredInlineFindings({
      [INLINE_FINDINGS_METADATA_KEY]: [
        { path: "src/a.ts", line: 2, severity: "blocker", body: "Fix me.", category: "security" },
        { path: "src/b.ts", line: 3, severity: "nit", body: "Rename this.", category: "not-a-category" },
      ],
    });
    expect(parsed).toEqual([
      { path: "src/a.ts", line: 2, severity: "blocker", body: "Fix me.", category: "security" },
      { path: "src/b.ts", line: 3, severity: "nit", body: "Rename this." },
    ]);
  });
});

describe("buildStructuredAiReviewFindings", () => {
  it("matches the PR comment category collapsible counts for the same findings", () => {
    const structured = buildStructuredAiReviewFindings(sampleFindings);
    const collapsible = buildFindingCategoryCollapsible(
      sampleFindings.map((finding) => ({ path: finding.path, body: finding.body, category: finding.category })),
    );
    expect(collapsible).not.toBeNull();
    const counts = buildFindingCategoryCounts(structured);
    expect(counts).toEqual({ security: 1, correctness: 1, tests: 1 });
    expect(collapsible?.body).toContain("| Security | 1 |");
    expect(collapsible?.body).toContain("| Correctness | 1 |");
    expect(collapsible?.body).toContain("| Tests | 1 |");
    expect(structured).toEqual([
      {
        category: "security",
        path: "src/db.ts",
        severity: "blocker",
        line: 12,
        body: "This is vulnerable to SQL injection.",
      },
      {
        category: "correctness",
        path: "src/util.ts",
        severity: "nit",
        line: 4,
        body: "This will throw on an empty array.",
      },
      {
        category: "tests",
        path: "src/app.test.ts",
        severity: "blocker",
        line: 9,
        body: "Assert the right value here.",
      },
    ]);
  });

  it("returns an empty structured list for no inline findings", () => {
    expect(buildStructuredAiReviewFindings([])).toEqual([]);
    expect(buildFindingCategoryCounts([])).toEqual({});
  });
});
