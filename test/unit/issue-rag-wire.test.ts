import { describe, expect, it } from "vitest";
import { buildIssueRagQuery } from "../../src/review/issue-rag-wire";

// ── buildIssueRagQuery (the issue-centric query composer, #2320) ────────────────────────────────────
// The ANALYZE-phase analogue of buildRagQuery: it composes the retrieval query from an ISSUE's title + body
// (+ labels) instead of a PR's changed files + diff. Pure, so every case is a plain input→output assertion.

describe("buildIssueRagQuery composes the retrieval query from an issue's title + body + labels", () => {
  it("PREPENDS the title, appends the body, then a labels hint line", () => {
    const { queryText } = buildIssueRagQuery({
      title: "Fix the OAuth device-flow token refresh",
      body: "The refresh call drops the scope parameter, so the second call 401s.",
      // A blank label is dropped so the hint line only carries real labels.
      labels: ["bug", "", "help wanted"],
    });
    expect(queryText).toContain("Fix the OAuth device-flow token refresh");
    expect(queryText).toContain("drops the scope parameter");
    expect(queryText).toContain("Labels: bug, help wanted");
    // The title LEADS the query (before the body), recall parity with buildRagQuery's title-led PR query.
    expect(queryText.indexOf("Fix the OAuth")).toBeLessThan(queryText.indexOf("drops the scope"));
  });

  it("emits just the title when there is no body and no labels", () => {
    const { queryText } = buildIssueRagQuery({
      title: "Refactor the review-enrichment circuit breaker to fail closed",
    });
    expect(queryText).toBe("Refactor the review-enrichment circuit breaker to fail closed");
    expect(queryText).not.toContain("Labels:");
  });

  it("omits a blank/whitespace title cleanly (the query then starts with the body, no leading newlines)", () => {
    const { queryText } = buildIssueRagQuery({
      title: "   ",
      body: "The public stats endpoint returns null when the SUM aggregates over an empty set.",
    });
    expect(queryText.startsWith("The public stats endpoint")).toBe(true);
    expect(queryText.startsWith("\n")).toBe(false);
  });

  it("degrades to an empty query below the MIN_QUERY_CHARS floor (a one-line issue isn't worth an embed)", () => {
    expect(buildIssueRagQuery({ title: "Typo in README" }).queryText).toBe("");
    // Whitespace-only title AND body → nothing to query on.
    expect(buildIssueRagQuery({ title: "  ", body: "   " }).queryText).toBe("");
  });

  it("truncates an over-budget body so the query stays within the bounded budget", () => {
    const { queryText } = buildIssueRagQuery({
      title: "Investigate the slow cross-repo fan-out",
      body: "y".repeat(4000) + "TAIL_BEYOND_THE_BUDGET",
    });
    expect(queryText).toContain("yyy");
    expect(queryText).not.toContain("TAIL_BEYOND_THE_BUDGET");
  });

  it("drops labels that are blank/whitespace, omitting the hint line when none survive", () => {
    const { queryText } = buildIssueRagQuery({
      title: "Add a per-repo max-concurrent-claims cap to the miner goal spec",
      labels: ["", "   "],
    });
    expect(queryText).not.toContain("Labels:");
  });
});

describe("buildIssueRagQuery invariants", () => {
  it("treats an absent labels field and an empty labels array identically", () => {
    const title = "Wire the issue-centric RAG query into the analyze phase";
    expect(buildIssueRagQuery({ title }).queryText).toBe(buildIssueRagQuery({ title, labels: [] }).queryText);
  });

  it("treats an absent body and a whitespace-only body identically", () => {
    const title = "Cache bare PR reads mirroring the head-SHA sync-state pattern";
    expect(buildIssueRagQuery({ title }).queryText).toBe(buildIssueRagQuery({ title, body: "   " }).queryText);
  });

  it("is pure: identical inputs always yield identical query text", () => {
    const input = { title: "Deterministic ranker ordering for opportunities", body: "Sort by descending score.", labels: ["feature"] };
    expect(buildIssueRagQuery(input).queryText).toBe(buildIssueRagQuery(input).queryText);
  });
});
