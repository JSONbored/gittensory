import { isCodeFile } from "./local-branch";

export const TEST_COVERAGE_STRONG_RATIO = 0.4;
export const TEST_COVERAGE_ADEQUATE_RATIO = 0.2;

export function isTestPath(file: string): boolean {
  return (
    /(^|\/)(test|tests|spec|__tests__)\//i.test(file) ||
    /(^|\/)src\/test\//i.test(file) ||
    /(^|\/)[^/]+_test\.(go|py|rb)$/i.test(file) ||
    /(^|\/)[^/]+_spec\.rb$/i.test(file) ||
    /\.(test|spec)\.(ts|tsx|js|jsx|py|rb|rs)$/i.test(file) ||
    /(^|\/)[^/]+\.(cy|e2e)\.(ts|tsx|js|jsx)$/i.test(file) ||
    /(^|\/)__snapshots__\//i.test(file)
  );
}

/** Fixture, mock, and test-data directories carry regression evidence even when the filename is not a test suffix. */
export function isFixturePath(file: string): boolean {
  return /(^|\/)(fixtures?|testdata|test-data|__fixtures__|mocks?|__mocks__)\//i.test(file);
}

export function isTestEvidencePath(file: string): boolean {
  return isTestPath(file) || isFixturePath(file);
}

export function hasLocalTestEvidence(input: { tests?: string[] | undefined; testFiles?: string[] | undefined }): boolean {
  return (input.tests ?? []).length > 0 || (input.testFiles ?? []).some((file) => isTestEvidencePath(file));
}

/**
 * Coarse classification of how much test coverage accompanies a set of changed paths.
 * Used by slop signals, workspace intelligence, and the contributor open-PR monitor to
 * distinguish absent, weak, adequate, and strong test accompaniment on code changes.
 */
export type TestCoverageClassification = "strong" | "adequate" | "weak" | "absent";

export type TestCoverageSummary = {
  classification: TestCoverageClassification;
  changedPathCount: number;
  sourcePathCount: number;
  testPathCount: number;
  fixturePathCount: number;
  /** Share of changed paths that are test or fixture evidence (0 when no paths). */
  testToChangedRatio: number;
  guidance: string;
};

export function classifyTestCoverage(changedPaths: string[]): TestCoverageClassification {
  return buildTestCoverageSummary(changedPaths).classification;
}

export function buildTestCoverageSummary(changedPaths: string[]): TestCoverageSummary {
  const uniquePaths = [...new Set(changedPaths.filter(Boolean))];
  const testPathCount = uniquePaths.filter(isTestPath).length;
  const fixturePathCount = uniquePaths.filter((path) => isFixturePath(path) && !isTestPath(path)).length;
  const evidencePathCount = testPathCount + fixturePathCount;
  const sourcePathCount = uniquePaths.filter((path) => isCodeFile(path) && !isTestEvidencePath(path)).length;
  const changedPathCount = uniquePaths.length;
  const testToChangedRatio = changedPathCount === 0 ? 0 : roundRatio(evidencePathCount / changedPathCount);
  const classification = classifyCoverageRatio(evidencePathCount, testToChangedRatio, sourcePathCount);
  return {
    classification,
    changedPathCount,
    sourcePathCount,
    testPathCount,
    fixturePathCount,
    testToChangedRatio,
    guidance: coverageGuidanceFor(classification, sourcePathCount, evidencePathCount),
  };
}

export function coverageGuidanceFor(
  classification: TestCoverageClassification,
  sourcePathCount: number,
  evidencePathCount = 0,
): string {
  if (sourcePathCount === 0) {
    return evidencePathCount > 0
      ? "Only test or fixture paths changed; no source-code accompaniment is expected."
      : "No source-code paths changed; test coverage guidance does not apply.";
  }
  switch (classification) {
    case "strong":
      return "Test or fixture changes are proportionally strong for the source files touched.";
    case "adequate":
      return "Some focused tests or fixtures accompany the source changes; consider adding edge-case coverage if the diff is broad.";
    case "weak":
      return "Source changes outnumber test evidence; add focused regression tests or fixtures for the touched modules.";
    case "absent":
    default:
      return "Code changes lack accompanying test files or fixtures; add focused regression coverage or explain why existing tests suffice.";
  }
}

function classifyCoverageRatio(
  evidencePathCount: number,
  testToChangedRatio: number,
  sourcePathCount: number,
): TestCoverageClassification {
  if (sourcePathCount === 0) return evidencePathCount > 0 ? "strong" : "absent";
  if (evidencePathCount === 0) return "absent";
  if (testToChangedRatio >= TEST_COVERAGE_STRONG_RATIO) return "strong";
  if (testToChangedRatio >= TEST_COVERAGE_ADEQUATE_RATIO) return "adequate";
  return "weak";
}

function roundRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}
