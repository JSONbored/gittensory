import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_CONTENT } from "../../scripts/forbidden-content.mjs";

// forbidden-content.mjs calls itself the "single source of truth" for the packaged secret-shape detector, but
// nothing enforced that: check-mcp-package.mjs re-declared the regex as its own literal and drifted silently
// (#6290). These assertions are source-level on purpose — both checkers run their `npm pack` dry-run at import
// time and export nothing, so a test cannot import them to compare the constants by identity.
const PACKAGE_CHECKERS = ["scripts/check-miner-package.mjs", "scripts/check-mcp-package.mjs"];

describe("FORBIDDEN_CONTENT is the single source of truth (#6290)", () => {
  it.each(PACKAGE_CHECKERS)("%s imports the shared constant rather than re-declaring it", (checker) => {
    const source = readFileSync(checker, "utf8");
    expect(source).toContain('import { FORBIDDEN_CONTENT } from "./forbidden-content.mjs";');
    expect(source).toContain("FORBIDDEN_CONTENT.test(");
    // A re-declared literal is exactly the drift this guards: a local `const ...Content = /.../` detector.
    expect(source).not.toMatch(/const\s+\w*[Ff]orbidden[Cc]ontent\s*=\s*\//);
  });

  it("is a stateless matcher, so both checkers can share the one instance safely", () => {
    // A /g regex would carry lastIndex across .test() calls and make shared use order-dependent.
    expect(FORBIDDEN_CONTENT.global).toBe(false);
    expect(FORBIDDEN_CONTENT.sticky).toBe(false);
  });
});
