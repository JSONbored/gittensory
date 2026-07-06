import { describe, expect, it } from "vitest";
import { fingerprint, matchSuppressions, normalizeFindingMessage, normalizeFindingPath } from "../../src/review/review-memory-match";
import type { ReviewSuppressionRecord } from "../../src/types";

function signal(overrides: Partial<ReviewSuppressionRecord> = {}): ReviewSuppressionRecord {
  return {
    id: "sig-1",
    repoFullName: "owner/repo",
    category: "ai_review_split",
    pathGlob: "",
    patternHash: "irrelevant",
    createdAt: "2026-01-01T00:00:00.000Z",
    createdBy: null,
    ...overrides,
  };
}

describe("normalizeFindingMessage", () => {
  it("lowercases, collapses whitespace runs, and trims", () => {
    expect(normalizeFindingMessage("  Some   Message\n\twith\tWHITESPACE  ")).toBe("some message with whitespace");
  });

  it("bounds an extremely long message so fingerprinting stays cheap", () => {
    const huge = "a".repeat(10_000);
    expect(normalizeFindingMessage(huge).length).toBe(4000);
  });

  it("is a no-op on an already-normalized message", () => {
    expect(normalizeFindingMessage("already normal")).toBe("already normal");
  });
});

describe("normalizeFindingPath", () => {
  it("canonicalizes a path (case + separator insensitive)", () => {
    expect(normalizeFindingPath("Src\\Foo\\Bar.ts")).toBe("src/foo/bar.ts");
  });

  it("defaults to '' (repo-wide) for null/undefined/empty path", () => {
    expect(normalizeFindingPath(null)).toBe("");
    expect(normalizeFindingPath(undefined)).toBe("");
    expect(normalizeFindingPath("")).toBe("");
  });
});

describe("fingerprint (#2180)", () => {
  it("is deterministic: the same input always yields the same fingerprint", () => {
    const finding = { category: "ai_review_split", path: "src/a.ts", message: "Some finding message." };
    expect(fingerprint(finding)).toBe(fingerprint({ ...finding }));
  });

  it("is stable across whitespace/case-only message differences (normalization applies before hashing)", () => {
    const a = fingerprint({ category: "ai_review_split", path: "src/a.ts", message: "Some Message" });
    const b = fingerprint({ category: "ai_review_split", path: "src/a.ts", message: "  some   message  " });
    expect(a).toBe(b);
  });

  it("is stable across path separator/case differences (canonicalization applies before hashing)", () => {
    const a = fingerprint({ category: "ai_review_split", path: "src/a.ts", message: "msg" });
    const b = fingerprint({ category: "ai_review_split", path: "Src\\A.ts", message: "msg" });
    expect(a).toBe(b);
  });

  it("differs when category differs (same path/message)", () => {
    const a = fingerprint({ category: "ai_review_split", path: "src/a.ts", message: "msg" });
    const b = fingerprint({ category: "ai_consensus_defect", path: "src/a.ts", message: "msg" });
    expect(a).not.toBe(b);
  });

  it("differs when path differs (same category/message)", () => {
    const a = fingerprint({ category: "ai_review_split", path: "src/a.ts", message: "msg" });
    const b = fingerprint({ category: "ai_review_split", path: "src/b.ts", message: "msg" });
    expect(a).not.toBe(b);
  });

  it("differs when message differs (same category/path)", () => {
    const a = fingerprint({ category: "ai_review_split", path: "src/a.ts", message: "msg one" });
    const b = fingerprint({ category: "ai_review_split", path: "src/a.ts", message: "msg two" });
    expect(a).not.toBe(b);
  });

  it("treats an absent path the same as an explicitly empty path (both repo-wide)", () => {
    const a = fingerprint({ category: "ai_review_split", message: "msg" });
    const b = fingerprint({ category: "ai_review_split", path: "", message: "msg" });
    expect(a).toBe(b);
  });
});

describe("matchSuppressions (#2180)", () => {
  const finding = { category: "ai_review_split", path: "src/foo/bar.ts", message: "The reviewer flagged X." };

  it("keep: an empty signal set never matches anything", () => {
    expect(matchSuppressions(finding, [])).toBe("keep");
  });

  it("suppress: an EXACT category+path+patternHash match", () => {
    const signals = [signal({ category: finding.category, pathGlob: "src/foo/**", patternHash: fingerprint(finding) })];
    expect(matchSuppressions(finding, signals)).toBe("suppress");
  });

  it("suppress: a repo-wide (empty pathGlob) exact patternHash match", () => {
    const signals = [signal({ category: finding.category, pathGlob: "", patternHash: fingerprint(finding) })];
    expect(matchSuppressions(finding, signals)).toBe("suppress");
  });

  it("demote: category+path scope matches but the patternHash differs (a different-worded finding at the same spot)", () => {
    const signals = [signal({ category: finding.category, pathGlob: "src/foo/**", patternHash: "some-other-hash" })];
    expect(matchSuppressions(finding, signals)).toBe("demote");
  });

  it("keep: category matches but the pathGlob scope does NOT cover this finding's path", () => {
    const signals = [signal({ category: finding.category, pathGlob: "test/**", patternHash: fingerprint(finding) })];
    expect(matchSuppressions(finding, signals)).toBe("keep");
  });

  it("keep: pathGlob would match but the category differs", () => {
    const signals = [signal({ category: "ai_consensus_defect", pathGlob: "src/foo/**", patternHash: fingerprint(finding) })];
    expect(matchSuppressions(finding, signals)).toBe("keep");
  });

  it("suppress wins over demote when BOTH an exact-hash signal and a scope-only signal exist for the same finding", () => {
    const signals = [
      signal({ id: "scope-only", category: finding.category, pathGlob: "src/foo/**", patternHash: "different-hash" }),
      signal({ id: "exact", category: finding.category, pathGlob: "src/foo/**", patternHash: fingerprint(finding) }),
    ];
    expect(matchSuppressions(finding, signals)).toBe("suppress");
  });

  it("demote: multiple scope-matching signals, none an exact hash match, still demotes (not suppress)", () => {
    const signals = [
      signal({ id: "a", category: finding.category, pathGlob: "src/foo/**", patternHash: "hash-a" }),
      signal({ id: "b", category: finding.category, pathGlob: "src/**", patternHash: "hash-b" }),
    ];
    expect(matchSuppressions(finding, signals)).toBe("demote");
  });

  it("keep: a finding with no path (repo-level) only matches a repo-wide ('') or wildcard pathGlob signal", () => {
    const repoLevelFinding = { category: "ai_review_inconclusive", message: "no usable verdict" };
    const scopedSignal = signal({ category: repoLevelFinding.category, pathGlob: "src/**", patternHash: "whatever" });
    expect(matchSuppressions(repoLevelFinding, [scopedSignal])).toBe("keep");
    const repoWideSignal = signal({ category: repoLevelFinding.category, pathGlob: "", patternHash: fingerprint(repoLevelFinding) });
    expect(matchSuppressions(repoLevelFinding, [repoWideSignal])).toBe("suppress");
  });

  it("an over-complex pathGlob (unsafe wildcard count) never matches, degrading to keep/demote rather than throwing", () => {
    // globToRegExp compiles an over-complex glob to NEVER_MATCHES rather than a real pattern (ReDoS guard).
    const overComplexGlob = "a*b*c*d*e*f*g*h*i*j*k*/**";
    const signals = [signal({ category: finding.category, pathGlob: overComplexGlob, patternHash: fingerprint(finding) })];
    expect(matchSuppressions(finding, signals)).toBe("keep");
  });
});
