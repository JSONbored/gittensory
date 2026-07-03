import { describe, expect, it } from "vitest";
import {
  buildTestCoverageSummary,
  classifyTestCoverage,
  coverageGuidanceFor,
  hasLocalTestEvidence,
  isFixturePath,
  isTestEvidencePath,
  isTestPath,
  TEST_COVERAGE_ADEQUATE_RATIO,
  TEST_COVERAGE_STRONG_RATIO,
} from "../../src/signals/test-evidence";

describe("test evidence helpers", () => {
  it("detects common test path conventions", () => {
    expect(isTestPath("pkg/foo_test.go")).toBe(true);
    expect(isTestPath("spec/models/widget_spec.rb")).toBe(true);
    expect(isTestPath("src/test/helpers.ts")).toBe(true);
    expect(isTestPath("tests/integration/api.test.ts")).toBe(true);
    expect(isTestPath("__tests__/widget.spec.tsx")).toBe(true);
    expect(isTestPath("e2e/login.spec.ts")).toBe(true);
    expect(isTestPath("integration/api_flow.cy.ts")).toBe(true);
    expect(isTestPath("playwright/smoke.spec.ts")).toBe(true);
    expect(isTestPath("cypress/e2e/checkout.cy.js")).toBe(true);
    expect(isTestPath("components/__snapshots__/Card.tsx.snap")).toBe(true);
    expect(isTestPath("src/state.snap")).toBe(false);
    expect(isTestPath("src/widget.rs")).toBe(false);
  });

  it("detects fixture, mock, and test-data directories as test evidence", () => {
    expect(isFixturePath("test/fixtures/pr.json")).toBe(true);
    expect(isFixturePath("src/__fixtures__/payload.ts")).toBe(true);
    expect(isFixturePath("testdata/input.yaml")).toBe(true);
    expect(isFixturePath("test-data/sample.json")).toBe(true);
    expect(isFixturePath("mocks/github.ts")).toBe(true);
    expect(isFixturePath("__mocks__/client.ts")).toBe(true);
    expect(isFixturePath("src/widget.ts")).toBe(false);
    expect(isTestEvidencePath("test/fixtures/pr.json")).toBe(true);
    expect(isTestEvidencePath("src/widget.ts")).toBe(false);
  });

  it("does not treat framework or integration directory names alone as test evidence", () => {
    expect(isTestPath("src/integration/auth.ts")).toBe(false);
    expect(isTestPath("src/playwright/client.ts")).toBe(false);
    expect(isTestPath("src/cypress/client.ts")).toBe(false);
    expect(isTestPath("src/e2e/client.ts")).toBe(false);
    expect(isTestPath("src/integration/auth.test.ts")).toBe(true);
    expect(isTestPath("src/playwright/client.e2e.ts")).toBe(true);
    expect(isTestPath("src/cypress/client.cy.ts")).toBe(true);
  });

  it("treats explicit test file lists and fixture paths as evidence", () => {
    expect(hasLocalTestEvidence({ testFiles: ["internal/cache_test.go"] })).toBe(true);
    expect(hasLocalTestEvidence({ testFiles: ["test/fixtures/payload.json"] })).toBe(true);
    expect(hasLocalTestEvidence({ tests: [] })).toBe(false);
    expect(hasLocalTestEvidence({})).toBe(false);
  });

  it("documents stable ratio thresholds for coverage classification", () => {
    expect(TEST_COVERAGE_STRONG_RATIO).toBe(0.4);
    expect(TEST_COVERAGE_ADEQUATE_RATIO).toBe(0.2);
  });
});

describe("classifyTestCoverage", () => {
  it("classifies an empty path list as absent", () => {
    expect(classifyTestCoverage([])).toBe("absent");
  });

  it("classifies a list with no test files as absent", () => {
    expect(classifyTestCoverage(["src/auth.ts", "src/utils.ts"])).toBe("absent");
  });

  it("classifies >= 40% test ratio as strong", () => {
    expect(classifyTestCoverage(["src/a.ts", "src/b.ts", "test/a.test.ts", "test/b.test.ts"])).toBe("strong");
    expect(classifyTestCoverage(["src/a.ts", "src/b.ts", "e2e/a.spec.ts", "e2e/b.spec.ts"])).toBe("strong");
  });

  it("classifies 20%–39% test ratio as adequate", () => {
    expect(classifyTestCoverage(["src/a.ts", "src/b.ts", "src/c.ts", "test/a.test.ts"])).toBe("adequate");
  });

  it("classifies > 0% but < 20% test ratio as weak", () => {
    const sources = Array.from({ length: 9 }, (_, i) => `src/file${i}.ts`);
    expect(classifyTestCoverage([...sources, "test/single.test.ts"])).toBe("weak");
  });

  it("counts fixture directories toward coverage without requiring a test suffix", () => {
    const sources = Array.from({ length: 5 }, (_, i) => `src/file${i}.ts`);
    expect(classifyTestCoverage([...sources, "test/fixtures/payload.json"])).toBe("weak");
    expect(classifyTestCoverage([...sources, "test/a.test.ts", "test/fixtures/payload.json"])).toBe("adequate");
  });
});

describe("buildTestCoverageSummary", () => {
  it("returns guidance that stays public-safe and actionable", () => {
    const summary = buildTestCoverageSummary(["src/a.ts", "src/b.ts", "src/c.ts", "test/a.test.ts"]);
    expect(summary).toMatchObject({
      classification: "adequate",
      changedPathCount: 4,
      sourcePathCount: 3,
      testPathCount: 1,
      fixturePathCount: 0,
      testToChangedRatio: 0.25,
    });
    expect(summary.guidance).toMatch(/Some focused tests/i);
    expect(JSON.stringify(summary)).not.toMatch(/wallet|hotkey|payout|trust score/i);
  });

  it("treats test-only diffs as strong without source accompaniment", () => {
    const summary = buildTestCoverageSummary(["test/unit/cache.test.ts", "test/fixtures/cache.json"]);
    expect(summary.classification).toBe("strong");
    expect(summary.sourcePathCount).toBe(0);
    expect(coverageGuidanceFor("strong", 0, 2)).toMatch(/Only test or fixture paths changed/i);
  });

  it("returns absent guidance when code changes have no test evidence", () => {
    const summary = buildTestCoverageSummary(["src/auth.ts", "src/utils.ts", "README.md"]);
    expect(summary.classification).toBe("absent");
    expect(summary.guidance).toMatch(/lack accompanying test files/i);
    expect(coverageGuidanceFor("absent", 2)).toMatch(/lack accompanying test files/i);
  });

  it("deduplicates repeated paths before counting", () => {
    const summary = buildTestCoverageSummary(["src/a.ts", "src/a.ts", "src/b.ts", "src/c.ts", "test/a.test.ts"]);
    expect(summary.changedPathCount).toBe(4);
    expect(summary.classification).toBe("adequate");
  });
});
