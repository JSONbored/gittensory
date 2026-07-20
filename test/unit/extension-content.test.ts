import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const contentScript = readFileSync("apps/loopover-extension/content.js", "utf8");
const manifest = JSON.parse(readFileSync("apps/loopover-extension/manifest.json", "utf8")) as {
  content_scripts: Array<{ matches: string[] }>;
};

describe("extension content script", () => {
  it("declares content-script matches for pull pages only (#7462)", () => {
    expect(manifest.content_scripts[0]?.matches).toEqual(["https://github.com/*/*/pull/*"]);
    expect(manifest.content_scripts[0]?.matches.join("\n")).not.toContain("issues");
  });

  it("detects GitHub pull request routes and treats issue pages as out of scope", () => {
    const internals = loadContentInternals();

    expect(internals.matchGitHubPageTarget("/JSONbored/loopover/pull/146")).toEqual({
      kind: "pull_request",
      owner: "JSONbored",
      repo: "loopover",
      pullNumber: 146,
    });
    // Issue pages are out of scope — no kind:"issue" classification, and no match.
    expect(internals.matchGitHubPageTarget("/JSONbored/loopover/issues/145")).toBeNull();
    expect(internals.matchGitHubPageTarget("/JSONbored/loopover/pulls")).toBeNull();
    expect(internals.matchPullRequestTarget("/JSONbored/loopover/pull/146")).toEqual({
      owner: "JSONbored",
      repo: "loopover",
      pullNumber: 146,
    });
    expect(internals.matchPullRequestTarget("/JSONbored/loopover/pull/146/files")).toEqual({
      owner: "JSONbored",
      repo: "loopover",
      pullNumber: 146,
    });
    expect(internals.matchPullRequestTarget("/JSONbored/loopover/issues/146")).toBeNull();
    expect(internals.matchPullRequestTarget("/JSONbored/loopover")).toBeNull();
  });

  it("renders private pull-context sections and escapes API text", () => {
    const internals = loadContentInternals();

    const html = internals.renderPullContext({
      sections: [
        {
          label: "Miner <Context>",
          badge: "confirmed",
          tone: "good",
          rows: [{ label: "author", value: "alice<script>" }],
          items: ["Official miner context is available."],
          actions: ["Compare linked issues before review."],
        },
      ],
    });

    expect(html).toContain("Miner &lt;Context&gt;");
    expect(html).toContain("alice&lt;script&gt;");
    expect(html).toContain("Official miner context is available.");
    expect(html).toContain("Compare linked issues before review.");
    expect(html).not.toContain("alice<script>");
  });

  it("falls back to legacy panels when sections are absent", () => {
    const internals = loadContentInternals();

    const html = internals.renderPullContext({
      panels: [{ label: "Boundary", badge: "private", rows: [{ k: "public", v: "no" }] }],
    });

    expect(html).toContain("Boundary");
    expect(html).toContain("private");
    expect(html).toContain("public");
    expect(html).toContain("no");
  });
});

function loadContentInternals() {
  const context: Record<string, unknown> = {
    __LOOPOVER_EXTENSION_TEST__: true,
    location: { pathname: "/JSONbored/loopover/issues/146" },
    document: {
      querySelector: vi.fn(() => null),
      createElement: vi.fn(() => {
        throw new Error("content script should not mount on non-PR routes in this test");
      }),
      body: { appendChild: vi.fn() },
    },
    chrome: { runtime: { sendMessage: vi.fn() } },
  };
  context.globalThis = context;
  const vmContext = createContext(context);
  new Script(contentScript).runInContext(vmContext);
  return vmContext.__loopoverContentInternals as {
    matchGitHubPageTarget: (
      pathname: string,
    ) => { kind: "pull_request"; owner: string; repo: string; pullNumber: number } | null;
    matchPullRequestTarget: (pathname: string) => { owner: string; repo: string; pullNumber: number } | null;
    renderPullContext: (payload: unknown) => string;
  };
}
