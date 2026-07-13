import { beforeAll, describe, expect, it } from "vitest";

let api;

beforeAll(async () => {
  globalThis.__GITTENSORY_MINER_EXTENSION_TEST__ = true;
  await import("./opportunity-badge.js");
  api = globalThis.__gittensoryMinerOpportunityBadgeTestExports;
});

describe("issueLookupKey", () => {
  it("builds a lowercase repo#number key", () => {
    expect(api.issueLookupKey("Owner/Repo", 42)).toBe("owner/repo#42");
  });

  it("returns null for a blank repo", () => {
    expect(api.issueLookupKey("  ", 42)).toBeNull();
  });

  it("returns null for a non-integer issue number", () => {
    expect(api.issueLookupKey("owner/repo", 1.5)).toBeNull();
  });

  it("returns null for a zero or negative issue number", () => {
    expect(api.issueLookupKey("owner/repo", 0)).toBeNull();
    expect(api.issueLookupKey("owner/repo", -3)).toBeNull();
  });
});

describe("lookupRankedOpportunity", () => {
  const entries = [
    { repoFullName: "owner/repo", issueNumber: 42, rankScore: 0.9 },
    { repoFullName: "owner/other", issueNumber: 7, rankScore: 0.2 },
  ];

  it("finds the matching entry case-insensitively", () => {
    expect(api.lookupRankedOpportunity(entries, "Owner/Repo", 42)).toBe(entries[0]);
  });

  it("returns null when no entry matches", () => {
    expect(api.lookupRankedOpportunity(entries, "owner/repo", 999)).toBeNull();
  });

  it("returns null when rankedIssues is not an array", () => {
    expect(api.lookupRankedOpportunity(null, "owner/repo", 42)).toBeNull();
  });

  it("returns null when the lookup key itself is invalid", () => {
    expect(api.lookupRankedOpportunity(entries, "", 42)).toBeNull();
  });

  it("skips non-object entries without throwing", () => {
    expect(api.lookupRankedOpportunity([null, 5, "x", entries[0]], "owner/repo", 42)).toBe(entries[0]);
  });
});

describe("scoreToTier", () => {
  it("labels a high score", () => {
    expect(api.scoreToTier(0.75)).toBe("High");
    expect(api.scoreToTier(0.9)).toBe("High");
  });

  it("labels a medium score", () => {
    expect(api.scoreToTier(0.5)).toBe("Medium");
    expect(api.scoreToTier(0.74)).toBe("Medium");
  });

  it("labels a low score", () => {
    expect(api.scoreToTier(0.49)).toBe("Low");
    expect(api.scoreToTier(0)).toBe("Low");
  });

  it("labels a non-finite score as Unknown", () => {
    expect(api.scoreToTier(Number.NaN)).toBe("Unknown");
    expect(api.scoreToTier(undefined)).toBe("Unknown");
  });
});

describe("buildOpportunityWhy", () => {
  it("lists every reason that clears its threshold, capped at two", () => {
    const why = api.buildOpportunityWhy({
      laneFit: 0.8,
      freshness: 0.8,
      potential: 0.8,
      feasibility: 0.8,
      dupRisk: 0.1,
    });
    expect(why).toBe("Strong lane fit; Fresh issue");
  });

  it("falls back to a balanced-signals message when nothing clears its threshold", () => {
    const why = api.buildOpportunityWhy({
      laneFit: 0.1,
      freshness: 0.1,
      potential: 0.1,
      feasibility: 0.1,
      dupRisk: 0.9,
    });
    expect(why).toBe("Balanced opportunity signals");
  });

  it("includes the low-duplicate-risk reason when dupRisk clears its own (inverted) threshold", () => {
    const why = api.buildOpportunityWhy({
      laneFit: 0,
      freshness: 0,
      potential: 0,
      feasibility: 0,
      dupRisk: 0.2,
    });
    expect(why).toBe("Low duplicate risk");
  });
});

describe("formatOpportunityBadge", () => {
  it("formats a finite rank score to two decimal places", () => {
    const badge = api.formatOpportunityBadge({
      rankScore: 0.856,
      laneFit: 0.8,
      freshness: 0,
      potential: 0,
      feasibility: 0,
      dupRisk: 0.9,
    });
    expect(badge).toMatchObject({ tier: "High", score: "0.86", rankScore: 0.856 });
  });

  it("degrades score to an em dash and rankScore to null when non-finite", () => {
    const badge = api.formatOpportunityBadge({
      rankScore: Number.NaN,
      laneFit: 0,
      freshness: 0,
      potential: 0,
      feasibility: 0,
      dupRisk: 0.9,
    });
    expect(badge).toMatchObject({ tier: "Unknown", score: "—", rankScore: null });
  });
});

describe("formatLastSyncedLabel", () => {
  it("returns null for a non-numeric savedAt", () => {
    expect(api.formatLastSyncedLabel(undefined, Date.now())).toBeNull();
    expect(api.formatLastSyncedLabel(Number.NaN, Date.now())).toBeNull();
  });

  it("labels just now for sub-minute deltas", () => {
    expect(api.formatLastSyncedLabel(1000, 30_000)).toBe("last synced just now");
  });

  it("labels minutes for sub-hour deltas", () => {
    expect(api.formatLastSyncedLabel(0, 5 * 60_000)).toBe("last synced 5m ago");
  });

  it("labels hours for sub-day deltas", () => {
    expect(api.formatLastSyncedLabel(0, 3 * 60 * 60_000)).toBe("last synced 3h ago");
  });

  it("labels days beyond 24h", () => {
    expect(api.formatLastSyncedLabel(0, 2 * 24 * 60 * 60_000)).toBe("last synced 2d ago");
  });

  it("clamps a marginally-future savedAt to zero delta instead of a negative age", () => {
    expect(api.formatLastSyncedLabel(10_000, 9_000)).toBe("last synced just now");
  });
});

describe("escapeOpportunityHtml", () => {
  it("escapes every HTML-sensitive character", () => {
    expect(api.escapeOpportunityHtml(`<b>"a" & 'b'</b>`)).toBe(
      "&lt;b&gt;&quot;a&quot; &amp; &#39;b&#39;&lt;/b&gt;",
    );
  });

  it("stringifies a non-string value first", () => {
    expect(api.escapeOpportunityHtml(42)).toBe("42");
  });
});

describe("renderOpportunityBadgeMarkup", () => {
  it("returns an empty string for a missing/non-object badge", () => {
    expect(api.renderOpportunityBadgeMarkup(null, null)).toBe("");
    expect(api.renderOpportunityBadgeMarkup("x", null)).toBe("");
  });

  it("renders the badge markup with the last-synced line when a label is given", () => {
    const markup = api.renderOpportunityBadgeMarkup(
      { tier: "High", score: "0.90", why: "Strong lane fit" },
      "last synced 2m ago",
    );
    expect(markup).toContain("High");
    expect(markup).toContain("0.90");
    expect(markup).toContain("Strong lane fit");
    expect(markup).toContain("last synced 2m ago");
  });

  it("omits the last-synced line entirely when no label is given", () => {
    const markup = api.renderOpportunityBadgeMarkup(
      { tier: "Low", score: "0.10", why: "Balanced opportunity signals" },
      null,
    );
    expect(markup).not.toContain("gittensory-miner-opportunity-badge__synced");
  });

  it("escapes badge field content so untrusted text cannot inject markup", () => {
    const markup = api.renderOpportunityBadgeMarkup(
      { tier: "<script>", score: "0.10", why: "x" },
      null,
    );
    expect(markup).not.toContain("<script>");
    expect(markup).toContain("&lt;script&gt;");
  });
});
