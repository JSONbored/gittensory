import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const GITHUB_APP_DOCS_PATH = resolve(
  import.meta.dirname,
  "../../apps/loopover-ui/content/docs/github-app.mdx",
);

describe("docs GitHub App setup page", () => {
  const source = readFileSync(GITHUB_APP_DOCS_PATH, "utf8");
  const normalizedSource = source.replace(/\s+/g, " ");

  it("documents self-hosting as the only currently available install path, and setup verification", () => {
    expect(source).not.toMatch(/https:\/\/github\.com\/apps\/gittensory\/installations\/new/);
    expect(source).toMatch(/Self-hosting is the only currently available path/);
    expect(source).toMatch(/Shared, centrally hosted App: not currently available/);
    expect(source).toMatch(/GET \/v1\/installations/);
    expect(source).toMatch(/GET \/v1\/repos\/:owner\/:repo\/registration-readiness/);
    expect(source).toMatch(/POST \/v1\/repos\/:owner\/:repo\/settings-preview/);
  });

  it("keeps Context advisory and Gate opt-in before branch protection", () => {
    expect(normalizedSource).toMatch(/\*\*LoopOver Context\*\* is advisory/);
    expect(normalizedSource).toMatch(/\*\*LoopOver Orb Review Agent\*\* is opt-in/);
    expect(normalizedSource).toMatch(/should require \*\*LoopOver Orb Review Agent\*\* only after/);
    expect(normalizedSource).toMatch(/Do not require \*\*LoopOver Context\*\*/);
  });
});
