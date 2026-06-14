import { describe, expect, it } from "vitest";
import {
  buildMissingTestEvidenceFinding,
  buildSlopAssessment,
  buildSlopRiskReport,
  buildTrivialWhitespaceChurnFinding,
  SLOP_RUBRIC_MARKDOWN,
  SLOP_WEIGHTS,
} from "../../src/signals/slop";

const FORBIDDEN_PUBLIC_TERMS =
  /wallet|hotkey|coldkey|mnemonic|reward|payout|raw trust|trust score|scoreability|private reviewability|\/Users|\/home|\/tmp/i;

describe("buildSlopAssessment", () => {
  it("exports rubric bands and a deterministic assessment shell", () => {
    expect(SLOP_RUBRIC_MARKDOWN).toContain("clean");
    expect(SLOP_RUBRIC_MARKDOWN).toContain("missing test evidence");
    expect(SLOP_RUBRIC_MARKDOWN).toContain("trivial / whitespace-only churn");

    const clean = buildSlopAssessment({});
    expect(clean).toEqual({ slopRisk: 0, band: "clean", findings: [] });
    expect(buildSlopAssessment({})).toEqual(clean);
  });

  it("raises missing-test-evidence slop for code-only diffs without tests", () => {
    const result = buildSlopAssessment({
      changedFiles: [{ path: "src/registry/sync.ts", additions: 24, deletions: 2 }],
    });

    expect(result.slopRisk).toBe(SLOP_WEIGHTS.missingTestEvidence);
    expect(result.band).toBe("elevated");
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: "missing_test_evidence",
        severity: "warning",
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("raises trivial-churn slop for high-churn diffs with minimal source lines", () => {
    const result = buildSlopAssessment({
      changedFiles: [
        { path: "README.md", additions: 30, deletions: 20 },
        { path: "docs/guide.md", additions: 25, deletions: 15 },
        { path: "src/widget.ts", additions: 2, deletions: 1 },
        { path: "test/unit/widget.test.ts", additions: 4, deletions: 0 },
      ],
    });

    expect(result.slopRisk).toBe(SLOP_WEIGHTS.trivialWhitespaceChurn);
    expect(result.band).toBe("elevated");
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: "trivial_whitespace_churn",
        severity: "warning",
      }),
    ]);
    expect(JSON.stringify(result)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  it("does not raise missing-test-evidence when changed test files are present", () => {
    expect(
      buildSlopAssessment({
        changedFiles: [
          { path: "src/registry/sync.ts", additions: 24, deletions: 2 },
          { path: "test/unit/registry-sync.test.ts", additions: 18, deletions: 0 },
        ],
      }),
    ).toEqual({ slopRisk: 0, band: "clean", findings: [] });
  });

  it("does not raise missing-test-evidence when external test evidence is supplied", () => {
    expect(
      buildSlopAssessment({
        changedFiles: [{ path: "src/registry/sync.ts", additions: 12, deletions: 0 }],
        testFiles: ["internal/cache_test.go"],
      }),
    ).toEqual({ slopRisk: 0, band: "clean", findings: [] });
  });

  it("does not raise trivial-churn when substantive source edits dominate", () => {
    expect(
      buildSlopAssessment({
        changedFiles: [
          { path: "src/registry/sync.ts", additions: 80, deletions: 20 },
          { path: "test/unit/registry-sync.test.ts", additions: 40, deletions: 5 },
        ],
      }),
    ).toEqual({ slopRisk: 0, band: "clean", findings: [] });
  });

  it("does not raise trivial-churn for small diffs below the churn threshold", () => {
    expect(
      buildSlopAssessment({
        changedFiles: [{ path: "README.md", additions: 10, deletions: 8 }],
      }),
    ).toEqual({ slopRisk: 0, band: "clean", findings: [] });
  });

  it("ignores docs-only diffs without code files for missing-test-evidence", () => {
    expect(
      buildSlopAssessment({
        changedFiles: [{ path: "README.md", additions: 10, deletions: 0 }],
      }),
    ).toEqual({ slopRisk: 0, band: "clean", findings: [] });
  });

  it("raises trivial-churn for non-code-only high-churn diffs", () => {
    expect(
      buildSlopAssessment({
        changedFiles: [
          { path: "README.md", additions: 25, deletions: 20 },
          { path: "docs/guide.md", additions: 20, deletions: 15 },
        ],
      }).findings.map((finding) => finding.code),
    ).toEqual(["trivial_whitespace_churn"]);
  });
});

describe("buildSlopRiskReport", () => {
  it("returns a clean report with no signals and the rubric", () => {
    const report = buildSlopRiskReport({ changedFiles: [{ path: "src/api/routes.ts" }], testFiles: ["test/unit/routes.test.ts"] });
    expect(report.slopRisk).toBe(0);
    expect(report.band).toBe("clean");
    expect(report.signals).toEqual([]);
    expect(report.rubric).toBe(SLOP_RUBRIC_MARKDOWN);
  });

  it("renders each signal as a public-safe {reason, howToFix} pair", () => {
    const report = buildSlopRiskReport({ changedFiles: [{ path: "src/api/routes.ts", additions: 5, deletions: 1 }] });
    expect(report.slopRisk).toBe(SLOP_WEIGHTS.missingTestEvidence);
    expect(report.band).toBe("elevated");
    expect(report.signals).toHaveLength(1);
    expect(report.signals[0]).toMatchObject({ code: "missing_test_evidence", reason: expect.any(String), howToFix: expect.any(String) });
    expect(report.signals[0]!.howToFix.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });

  // Regression guard for the published CLI tool (bin/gittensory-mcp.js): the trivial_whitespace_churn
  // signal only fires when per-file additions/deletions reach the rubric. If the bin ever flattens the
  // local diff back to bare path strings, churn silently disappears and slopRisk caps at missing-tests
  // only — this pins both halves of that contract so the dead-signal regression can't return unnoticed.
  it("only fires trivial-churn when per-file additions/deletions are forwarded", () => {
    const churnDiff = [
      { path: "README.md", additions: 30, deletions: 20 },
      { path: "docs/guide.md", additions: 25, deletions: 15 },
    ];

    const withLineCounts = buildSlopRiskReport({ changedFiles: churnDiff });
    expect(withLineCounts.signals.map((signal) => signal.code)).toContain("trivial_whitespace_churn");

    const barePaths = buildSlopRiskReport({ changedFiles: churnDiff.map((file) => ({ path: file.path })) });
    expect(barePaths.signals.map((signal) => signal.code)).not.toContain("trivial_whitespace_churn");
  });
});

describe("buildMissingTestEvidenceFinding", () => {
  it("keeps public reason strings sanitized", () => {
    const finding = buildMissingTestEvidenceFinding({
      changedFiles: [{ path: "src/api/routes.ts", additions: 3, deletions: 0 }],
    });

    expect(finding).toMatchObject({
      code: "missing_test_evidence",
      publicText: expect.any(String),
    });
    expect(JSON.stringify(finding)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });
});

describe("buildTrivialWhitespaceChurnFinding", () => {
  it("keeps public reason strings sanitized", () => {
    const finding = buildTrivialWhitespaceChurnFinding({
      changedFiles: [
        { path: "README.md", additions: 30, deletions: 20 },
        { path: "docs/guide.md", additions: 25, deletions: 15 },
      ],
    });

    expect(finding).toMatchObject({
      code: "trivial_whitespace_churn",
      publicText: expect.any(String),
    });
    expect(JSON.stringify(finding)).not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });
});
