import { describe, expect, it } from "vitest";
import { buildNewcomerGuideComment, NEWCOMER_GUIDE_COMMENT_MARKER } from "../../src/signals/newcomer-guide";
import type { Advisory } from "../../src/types";

function makeAdvisory(findings: Array<{ code: string; severity: string; title: string; detail: string }>): Advisory {
  return {
    id: "test-id",
    targetType: "pull_request",
    targetKey: "test/test#1",
    repoFullName: "test/test",
    pullNumber: 1,
    headSha: "abc123",
    conclusion: "neutral",
    severity: "info",
    title: "Test",
    summary: "Test summary",
    findings: findings as Advisory["findings"],
    generatedAt: "2026-01-01T00:00:00Z",
  };
}

describe("buildNewcomerGuideComment", () => {
  it("includes the newcomer guide marker", () => {
    const result = buildNewcomerGuideComment({
      authorLogin: "alice",
      pullNumber: 1,
      title: "Fix bug",
      repoFullName: "test/test",
      advisory: makeAdvisory([{ code: "missing_linked_issue", severity: "warning", title: "No linked issue", detail: "d" }]),
      gateBlocking: false,
    });
    expect(result).toContain(NEWCOMER_GUIDE_COMMENT_MARKER);
  });

  it("welcomes the author by login", () => {
    const result = buildNewcomerGuideComment({
      authorLogin: "alice",
      pullNumber: 1,
      title: "Fix bug",
      repoFullName: "test/test",
      advisory: makeAdvisory([]),
      gateBlocking: false,
    });
    expect(result).toContain("@alice");
    expect(result).toContain("Welcome");
  });

  it("includes specific guidance for missing_linked_issue finding", () => {
    const result = buildNewcomerGuideComment({
      authorLogin: "bob",
      pullNumber: 2,
      title: "Add feature",
      repoFullName: "test/test",
      advisory: makeAdvisory([{ code: "missing_linked_issue", severity: "warning", title: "No linked issue", detail: "d" }]),
      gateBlocking: false,
    });
    expect(result).toContain("Link a related issue");
    expect(result).toContain("Closes #123");
  });

  it("includes specific guidance for slop_detected finding", () => {
    const result = buildNewcomerGuideComment({
      authorLogin: "bob",
      pullNumber: 2,
      title: "Add feature",
      repoFullName: "test/test",
      advisory: makeAdvisory([{ code: "slop_detected", severity: "warning", title: "Slop detected", detail: "d" }]),
      gateBlocking: false,
    });
    expect(result).toContain("Avoid auto-generated");
  });

  it("includes merge-worthy checklist", () => {
    const result = buildNewcomerGuideComment({
      authorLogin: "alice",
      pullNumber: 1,
      title: "Fix bug",
      repoFullName: "test/test",
      advisory: makeAdvisory([]),
      gateBlocking: false,
    });
    expect(result).toContain("What makes a PR merge-worthy");
    expect(result).toContain("Small and focused");
    expect(result).toContain("Linked to an issue");
    expect(result).toContain("Tested");
  });

  it("shows warning when gate is blocking", () => {
    const result = buildNewcomerGuideComment({
      authorLogin: "alice",
      pullNumber: 1,
      title: "Fix bug",
      repoFullName: "test/test",
      advisory: makeAdvisory([{ code: "missing_linked_issue", severity: "warning", title: "No linked issue", detail: "d" }]),
      gateBlocking: true,
    });
    expect(result).toContain("⚠️");
  });

  it("shows success message when gate is not blocking", () => {
    const result = buildNewcomerGuideComment({
      authorLogin: "alice",
      pullNumber: 1,
      title: "Fix bug",
      repoFullName: "test/test",
      advisory: makeAdvisory([]),
      gateBlocking: false,
    });
    expect(result).toContain("✅");
  });

  it("truncates long titles", () => {
    const longTitle = "A".repeat(120);
    const result = buildNewcomerGuideComment({
      authorLogin: "alice",
      pullNumber: 1,
      title: longTitle,
      repoFullName: "test/test",
      advisory: makeAdvisory([]),
      gateBlocking: false,
    });
    expect(result).toContain("…");
    expect(result).not.toContain("A".repeat(120));
  });

  it("deduplicates findings by code", () => {
    const result = buildNewcomerGuideComment({
      authorLogin: "alice",
      pullNumber: 1,
      title: "Fix bug",
      repoFullName: "test/test",
      advisory: makeAdvisory([
        { code: "missing_linked_issue", severity: "warning", title: "A", detail: "d" },
        { code: "missing_linked_issue", severity: "warning", title: "B", detail: "d" },
      ]),
      gateBlocking: false,
    });
    const count = (result!.match(/Link a related issue/g) ?? []).length;
    expect(count).toBe(1);
  });
});
