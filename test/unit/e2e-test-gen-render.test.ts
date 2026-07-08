import { describe, expect, it } from "vitest";
import { buildE2eTestGenCommentBody } from "../../src/review/e2e-test-gen-render";
import { PR_PANEL_COMMENT_MARKER } from "../../src/github/comments";

describe("buildE2eTestGenCommentBody", () => {
  it("renders the generated test source in a fenced code block, defaulting the framework to Playwright", () => {
    const body = buildE2eTestGenCommentBody({ actor: "maintainer", testSource: "test('x', () => {});" });
    expect(body).toContain(PR_PANEL_COMMENT_MARKER);
    expect(body).toContain("AI-generated Playwright test for @maintainer");
    expect(body).toContain("```typescript\ntest('x', () => {});\n```");
  });

  it("uses a custom framework name when provided", () => {
    const body = buildE2eTestGenCommentBody({ actor: "maintainer", testSource: "it('x', () => {});", framework: "Cypress" });
    expect(body).toContain("AI-generated Cypress test for @maintainer");
  });

  it("renders a not-usable note (no code fence) when testSource is null", () => {
    const body = buildE2eTestGenCommentBody({ actor: "maintainer", testSource: null });
    expect(body).toContain(PR_PANEL_COMMENT_MARKER);
    expect(body).toContain("did not produce a usable result");
    expect(body).not.toContain("```");
  });

  it("names the configured framework in the not-usable note too", () => {
    const body = buildE2eTestGenCommentBody({ actor: "maintainer", testSource: null, framework: "Cypress" });
    expect(body).toContain("didn't parse as valid Cypress source");
  });
});
