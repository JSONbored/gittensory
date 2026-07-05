import { describe, expect, it } from "vitest";
import { classifyFindingCategory, FINDING_CATEGORIES, isFindingCategory } from "../../src/review/finding-category-classify";

describe("isFindingCategory (#1958)", () => {
  it("accepts every value in the fixed enum", () => {
    for (const category of FINDING_CATEGORIES) {
      expect(isFindingCategory(category)).toBe(true);
    }
  });

  it("rejects a value outside the fixed enum", () => {
    expect(isFindingCategory("readability")).toBe(false);
  });

  it("rejects the wrong case (case-sensitive)", () => {
    expect(isFindingCategory("Security")).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(isFindingCategory(1)).toBe(false);
    expect(isFindingCategory(null)).toBe(false);
    expect(isFindingCategory(undefined)).toBe(false);
    expect(isFindingCategory({})).toBe(false);
  });
});

describe("classifyFindingCategory (#1958)", () => {
  it("tests: a finding anchored to a test file, regardless of body wording", () => {
    expect(classifyFindingCategory({ path: "src/app.test.ts", body: "This looks fine." })).toBe("tests");
  });

  it("security: SQL injection wording", () => {
    expect(classifyFindingCategory({ path: "src/db.ts", body: "This query is vulnerable to SQL injection." })).toBe("security");
  });

  it("security: hardcoded credential wording", () => {
    expect(classifyFindingCategory({ path: "src/config.ts", body: "This hardcoded password should be a secret." })).toBe("security");
  });

  it("performance: N+1 wording", () => {
    expect(classifyFindingCategory({ path: "src/api.ts", body: "This introduces an N+1 query inside the loop." })).toBe("performance");
  });

  it("tests: missing-test wording on a non-test file", () => {
    expect(classifyFindingCategory({ path: "src/util.ts", body: "This branch has no test coverage." })).toBe("tests");
  });

  it("style: naming/formatting wording", () => {
    expect(classifyFindingCategory({ path: "src/util.ts", body: "This variable naming is inconsistent." })).toBe("style");
  });

  it("maintainability: duplication wording", () => {
    expect(classifyFindingCategory({ path: "src/util.ts", body: "This duplicates logic already in helpers.ts." })).toBe("maintainability");
  });

  it("falls through to correctness when nothing matches", () => {
    expect(classifyFindingCategory({ path: "src/util.ts", body: "This will throw when the array is empty." })).toBe("correctness");
  });

  it("precedence: a test-path finding wins over security wording in the body (path checked first)", () => {
    expect(classifyFindingCategory({ path: "test/unit/auth.test.ts", body: "This test bypasses authentication entirely." })).toBe("tests");
  });

  it("precedence: security wording wins over performance wording in the same body", () => {
    expect(
      classifyFindingCategory({
        path: "src/api.ts",
        body: "This SQL injection risk also causes a slow N+1 query.",
      }),
    ).toBe("security");
  });
});
