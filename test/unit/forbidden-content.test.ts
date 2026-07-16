import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateMcpPackFileList } from "../../scripts/check-mcp-package.mjs";
import { validateMinerPackFileList } from "../../scripts/check-miner-package.mjs";
import { FORBIDDEN_CONTENT } from "../../scripts/forbidden-content.mjs";

// forbidden-content.mjs calls itself the single source of truth for the packaged secret-shape detector, but
// nothing enforced it: check-mcp-package.mjs re-declared the regex as its own literal and the two could drift
// apart unnoticed (#6290). These assertions pin both halves of that claim -- the structural one (each checker
// imports the constant rather than owning a copy) and the behavioral one (each checker actually rejects what
// the shared detector matches).
const PACKAGE_CHECKERS = ["scripts/check-miner-package.mjs", "scripts/check-mcp-package.mjs"];

// Assembled from fragments so this file never itself contains a credential-shaped literal -- the same
// convention check-mcp-package.test.ts and check-miner-package.test.ts already use for their probes.
const SECRET_SHAPED_PROBE = ["PROBE", "_", "SECRET", "=", "value"].join("");

describe("FORBIDDEN_CONTENT is the single source of truth (#6290)", () => {
  it.each(PACKAGE_CHECKERS)("%s imports the shared constant instead of re-declaring it", (checker) => {
    const source = readFileSync(checker, "utf8");
    expect(source).toContain('import { FORBIDDEN_CONTENT } from "./forbidden-content.mjs";');
    expect(source).toContain("FORBIDDEN_CONTENT.test(");
    // The drift this guards against: a checker owning its own copy of the detector.
    expect(source).not.toMatch(/const\s+FORBIDDEN_CONTENT\s*=/);
  });

  it("both checkers reject exactly what the shared detector matches", () => {
    expect(FORBIDDEN_CONTENT.test(SECRET_SHAPED_PROBE)).toBe(true);
    expect(() => validateMcpPackFileList(["package.json"], () => SECRET_SHAPED_PROBE)).toThrow(
      /Secret-like content found in MCP package file/,
    );
    expect(() => validateMinerPackFileList(["package.json"], () => SECRET_SHAPED_PROBE)).toThrow(
      /Secret-like content found in miner package file/,
    );
  });

  // Scoped to the MCP checker: the miner one layers required-file/lib-artifact guards on top, so a clean-content
  // assertion there would be testing its allowlist rather than the shared detector.
  it("does not flag content the shared detector leaves alone", () => {
    const clean = "export const answer = 42;";
    expect(FORBIDDEN_CONTENT.test(clean)).toBe(false);
    expect(() => validateMcpPackFileList(["package.json"], () => clean)).not.toThrow();
  });

  it("is a stateless matcher, so the shared instance is safe across checkers", () => {
    // A global/sticky regex would carry lastIndex between .test() calls and make shared use order-dependent.
    expect(FORBIDDEN_CONTENT.global).toBe(false);
    expect(FORBIDDEN_CONTENT.sticky).toBe(false);
    expect(FORBIDDEN_CONTENT.test(SECRET_SHAPED_PROBE)).toBe(true);
    expect(FORBIDDEN_CONTENT.test(SECRET_SHAPED_PROBE)).toBe(true);
  });
});
