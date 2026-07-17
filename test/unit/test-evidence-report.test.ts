import { describe, expect, it } from "vitest";
import { buildTestEvidenceReport } from "../../src/signals/test-evidence";

// #6749: buildTestEvidenceReport is the single implementation the MCP tool, POST /v1/lint/test-evidence, and the
// CLI mirror all share. Its consumers' tests assert parity WITH this builder, which proves wiring but not the
// builder's own correctness — so these assert exact classification values independently, pinning both ratio
// boundaries (0.4 strong, 0.2 adequate) that classifyTestCoverage uses.
describe("buildTestEvidenceReport (#6749)", () => {
  it("classifies each ratio band exactly, at and around the 0.4 / 0.2 boundaries", () => {
    // 2 tests / 5 total = 0.4 -> exactly ON the strong boundary.
    expect(buildTestEvidenceReport({ changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts"], testFiles: ["test/a.test.ts", "test/b.test.ts"] }).classification).toBe("strong");
    // 1 test / 5 total = 0.2 -> exactly ON the adequate boundary.
    expect(buildTestEvidenceReport({ changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"], testFiles: ["test/a.test.ts"] }).classification).toBe("adequate");
    // 1 test / 6 total ≈ 0.17 -> just BELOW adequate.
    expect(buildTestEvidenceReport({ changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"], testFiles: ["test/a.test.ts"] }).classification).toBe("weak");
    // no test paths at all -> absent.
    expect(buildTestEvidenceReport({ changedPaths: ["src/a.ts"] }).classification).toBe("absent");
    // no paths at all -> absent.
    expect(buildTestEvidenceReport({ changedPaths: [] }).classification).toBe("absent");
  });

  it("counts changed/code/test files independently of the classification", () => {
    const report = buildTestEvidenceReport({ changedPaths: ["src/a.ts", "README.md"], testFiles: ["test/a.test.ts"] });
    expect(report).toMatchObject({ changedFileCount: 3, codeFileCount: 1, testFileCount: 1 });
  });

  it("credits free-text tests evidence ONLY to lift an absent verdict — never to loosen a real one", () => {
    const lifted = buildTestEvidenceReport({ changedPaths: ["src/a.ts"], tests: ["ran `go test ./...` locally"] });
    expect(lifted.classification).toBe("adequate");
    expect(lifted.testFileCount).toBe(1);
    expect(lifted.guidance.join(" ")).toMatch(/free-text/i);

    // A weak verdict already has real path evidence, so free-text notes must NOT upgrade it.
    const weak = buildTestEvidenceReport({
      changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
      testFiles: ["test/a.test.ts"],
      tests: ["ran everything, honest"],
    });
    expect(weak.classification).toBe("weak");

    // An empty free-text array is not evidence.
    expect(buildTestEvidenceReport({ changedPaths: ["src/a.ts"], tests: [] }).classification).toBe("absent");

    // testFiles supplied but containing NO real test path: the verdict is still absent, and the free-text
    // credit path still inspects those files (hasLocalTestEvidence re-checks them) rather than skipping them.
    expect(buildTestEvidenceReport({ changedPaths: ["src/a.ts"], testFiles: ["src/helper.ts"] }).classification).toBe("absent");
    // …and the same non-test testFiles DO get credited once a real test path is among them.
    expect(buildTestEvidenceReport({ changedPaths: ["src/a.ts"], testFiles: ["src/helper.ts", "test/a.test.ts"] }).classification).not.toBe("absent");
  });

  it("renders the right guidance arm for each outcome", () => {
    expect(buildTestEvidenceReport({ changedPaths: ["README.md"] }).guidance.join(" ")).toMatch(/does not apply/i);
    expect(buildTestEvidenceReport({ changedPaths: ["src/a.ts"] }).guidance.join(" ")).toMatch(/no test evidence/i);
    expect(buildTestEvidenceReport({ changedPaths: ["src/a.ts"], testFiles: ["test/a.test.ts"] }).guidance.join(" ")).toMatch(/strong/i);
    expect(
      buildTestEvidenceReport({ changedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"], testFiles: ["test/a.test.ts"] }).guidance.join(" "),
    ).toMatch(/adding another focused test/i);
  });

  it("accepts readonly inputs without mutating the caller's arrays", () => {
    const changedPaths: readonly string[] = Object.freeze(["src/a.ts"]);
    const tests: readonly string[] = Object.freeze(["ran the suite"]);
    expect(() => buildTestEvidenceReport({ changedPaths, tests })).not.toThrow();
    expect(changedPaths).toEqual(["src/a.ts"]);
  });
});
