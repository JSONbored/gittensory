import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { describe, expect, it } from "vitest";

const contentScript = readFileSync("apps/gittensory-miner-extension/content.js", "utf8");
const backgroundScript = readFileSync("apps/gittensory-miner-extension/background.js", "utf8");
const optionsScript = readFileSync("apps/gittensory-miner-extension/options.js", "utf8");
const manifest = JSON.parse(readFileSync("apps/gittensory-miner-extension/manifest.json", "utf8"));

describe("miner extension scaffold", () => {
  it("ships a Manifest V3 issue-page-only content script surface", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toContain("Miner");
    expect(manifest.content_scripts).toHaveLength(1);
    expect(manifest.content_scripts[0].matches).toEqual(["https://github.com/*/*/issues/*"]);
    expect(manifest.background.service_worker).toBe("background.js");
    expect(manifest.options_page).toBe("options.html");
  });

  it("detects GitHub issue routes without matching pull requests", () => {
    const internals = loadContentInternals();

    expect(internals.matchGitHubIssueTarget("/JSONbored/gittensory/issues/145")).toEqual({
      kind: "issue",
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });
    expect(internals.matchGitHubIssueTarget("/JSONbored/gittensory/pull/146")).toBeNull();
    expect(internals.matchGitHubIssueTarget("/JSONbored/gittensory/issues")).toBeNull();
  });

  it("renders the watched-repo shell placeholder without a badge payload", () => {
    const internals = loadContentInternals();
    const container = createMockContainer();

    internals.renderIssueShell(container, {
      watched: true,
      issueNumber: 145,
      repoFullName: "JSONbored/gittensory",
      badge: null,
      status: "shell-ready",
    });

    expect(container.hidden).toBe(false);
    expect(container.textContent).toContain("opportunity shell");
  });

  it("keeps the shell hidden for unwatched repositories", () => {
    const internals = loadContentInternals();
    const container = createMockContainer();

    internals.renderIssueShell(container, {
      watched: false,
      issueNumber: 145,
      repoFullName: "JSONbored/gittensory",
      badge: null,
      status: "repo-not-watched",
    });

    expect(container.hidden).toBe(true);
  });

  it("returns shell-ready issue context for watched repositories", async () => {
    const internals = loadBackgroundInternals({
      watchedRepos: ["JSONbored/gittensory"],
    });

    const payload = await internals.loadIssueContextShell({
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });

    expect(payload).toEqual({
      watched: true,
      issueNumber: 145,
      repoFullName: "JSONbored/gittensory",
      badge: null,
      status: "shell-ready",
    });
  });

  it("parses watched repositories from newline or comma separated options input", () => {
    const internals = loadOptionsInternals();
    expect(internals.parseWatchedRepos("JSONbored/gittensory\nowner/repo")).toEqual([
      "JSONbored/gittensory",
      "owner/repo",
    ]);
    expect(internals.parseWatchedRepos("JSONbored/gittensory, owner/repo")).toEqual([
      "JSONbored/gittensory",
      "owner/repo",
    ]);
  });
});

function createMockContainer() {
  const container = {
    hidden: false,
    textContent: "",
    dataset: {} as Record<string, string>,
    appendChild(node: { textContent?: string }) {
      if (node.textContent) {
        container.textContent += node.textContent;
      }
    },
  };
  return container as {
    hidden: boolean;
    textContent: string;
    dataset: Record<string, string>;
    appendChild: (node: { textContent?: string }) => void;
  };
}

function loadContentInternals() {
  const context: Record<string, unknown> = {
    __GITTENSORY_MINER_EXTENSION_TEST__: true,
    location: { pathname: "/JSONbored/gittensory/pull/146" },
    document: {
      querySelector: () => null,
      createElement: () => createMockContainer(),
      body: { appendChild: () => {} },
    },
    chrome: { runtime: { sendMessage: async () => ({ ok: true, payload: { watched: true } }) } },
  };
  context.globalThis = context;
  const vmContext = createContext(context);
  new Script(contentScript).runInContext(vmContext);
  return vmContext.__gittensoryMinerContentInternals as {
    matchGitHubIssueTarget: (
      pathname: string,
    ) => { kind: "issue"; owner: string; repo: string; issueNumber: number } | null;
    renderIssueShell: (container: { hidden: boolean; textContent: string }, payload: unknown) => void;
  };
}

function loadBackgroundInternals({ watchedRepos = [] as string[] } = {}) {
  const context: Record<string, unknown> = {
    __GITTENSORY_MINER_EXTENSION_TEST__: true,
    chrome: {
      storage: { sync: { get: async () => ({ watchedRepos }) } },
      runtime: { onMessage: { addListener: () => {} } },
    },
  };
  context.globalThis = context;
  const vmContext = createContext(context);
  new Script(backgroundScript).runInContext(vmContext);
  return vmContext.__gittensoryMinerBackgroundInternals as {
    loadIssueContextShell: (message: {
      owner: string;
      repo: string;
      issueNumber: number;
    }) => Promise<Record<string, unknown>>;
  };
}

function loadOptionsInternals() {
  const context: Record<string, unknown> = {
    __GITTENSORY_MINER_EXTENSION_TEST__: true,
    document: {
      querySelector: () => null,
    },
    chrome: {
      storage: { sync: { get: async () => ({ watchedRepos: [] }), set: async () => {} } },
    },
    setTimeout: () => 0,
  };
  context.globalThis = context;
  const vmContext = createContext(context);
  new Script(optionsScript).runInContext(vmContext);
  return vmContext.__gittensoryMinerOptionsInternals as {
    parseWatchedRepos: (text: string) => string[];
  };
}
