import { readFileSync } from "node:fs";
import { Script, createContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rankCandidateIssues } from "../../packages/gittensory-miner/lib/opportunity-ranker.js";

const contentScript = readFileSync("apps/gittensory-miner-extension/content.js", "utf8");
const backgroundScript = readFileSync("apps/gittensory-miner-extension/background.js", "utf8");
const badgeScript = readFileSync("apps/gittensory-miner-extension/opportunity-badge.js", "utf8");
const calibrationTrendScript = readFileSync("apps/gittensory-miner-extension/calibration-accuracy-trend.js", "utf8");
const calibrationPanelScript = readFileSync("apps/gittensory-miner-extension/calibration-trend-panel.js", "utf8");
const panelRegistryScript = readFileSync("apps/gittensory-miner-extension/panel-registry.js", "utf8");
const optionsScript = readFileSync("apps/gittensory-miner-extension/options.js", "utf8");
const manifest = JSON.parse(readFileSync("apps/gittensory-miner-extension/manifest.json", "utf8"));

const CALIBRATION_SNAPSHOTS_STORAGE_KEY = "calibrationAccuracySnapshots";
const NOW = Date.parse("2026-07-03T12:00:00.000Z");

function rawIssue(overrides: Record<string, unknown> = {}) {
  return {
    owner: "JSONbored",
    repo: "gittensory",
    repoFullName: "JSONbored/gittensory",
    issueNumber: 145,
    title: "Add miner extension badge",
    labels: ["help wanted", "gittensor:feature"],
    commentsCount: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    htmlUrl: "https://github.com/JSONbored/gittensory/issues/145",
    aiPolicyAllowed: true as const,
    aiPolicySource: "CONTRIBUTING.md" as const,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("miner extension opportunity badge", () => {
  it("ships browser-loadable content scripts without ESM export syntax", () => {
    expect(badgeScript).not.toMatch(/\bexport\s+/);
    expect(calibrationTrendScript).not.toMatch(/\bexport\s+/);
    expect(calibrationPanelScript).not.toMatch(/\bexport\s+/);
    expect(panelRegistryScript).not.toMatch(/\bexport\s+/);
  });

  it("ships a Manifest V3 issue-page content script with badge and calibration panel assets", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.content_scripts[0].matches).toEqual(["https://github.com/*/*/issues/*"]);
    expect(manifest.content_scripts[0].js).toEqual([
      "opportunity-badge.js",
      "calibration-accuracy-trend.js",
      "calibration-trend-panel.js",
      "panel-registry.js",
      "content.js",
    ]);
    expect(manifest.content_scripts[0].css).toEqual(["styles.css"]);
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
  });

  it("looks up ranked opportunities using the same repo#issue key as the miner ranker", () => {
    const ranked = rankCandidateIssues([rawIssue(), rawIssue({ issueNumber: 99, labels: ["question"] })], {
      nowMs: NOW,
    });
    const badge = loadBadgeInternals();

    const match = badge.lookupRankedOpportunity(ranked, "JSONbored/gittensory", 145);
    expect(match?.issueNumber).toBe(145);
    expect(match?.rankScore).toBeGreaterThan(0);
    expect(badge.lookupRankedOpportunity(ranked, "JSONbored/gittensory", 404)).toBeNull();
  });

  it("formats tier, score, and a short why without duplicating ranking math", () => {
    const ranked = rankCandidateIssues([rawIssue()], { nowMs: NOW })[0]!;
    const badge = loadBadgeInternals();
    const formatted = badge.formatOpportunityBadge(ranked);

    expect(formatted.tier).toMatch(/High|Medium|Low/);
    expect(formatted.score).toMatch(/^\d+\.\d{2}$/);
    expect(formatted.why.length).toBeGreaterThan(0);
    expect(badge.renderOpportunityBadgeMarkup(formatted)).toContain("Read-only");
    expect(badge.renderOpportunityBadgeMarkup(formatted)).not.toContain("<script>");
  });

  it("renders the badge when a ranked signal is available and removes it otherwise", () => {
    const internals = loadContentInternals();
    const container = createMockContainer();
    const ranked = rankCandidateIssues([rawIssue()], { nowMs: NOW })[0]!;
    const badge = loadBadgeInternals();
    const formatted = badge.formatOpportunityBadge(ranked);

    internals.renderOpportunityBadge(container, {
      watched: true,
      badge: formatted,
      status: "ready",
    });
    expect(container.hidden).toBe(false);
    expect(container.innerHTML).toContain("Gittensory opportunity");
    expect(container.innerHTML).toContain(formatted.tier);

    const missing = createMockContainer();
    internals.renderOpportunityBadge(missing, { watched: true, badge: null, status: "no-signal" });
    expect(missing.removed).toBe(true);
  });

  it("returns ready context when watched repo has a cached ranked candidate", async () => {
    const ranked = rankCandidateIssues([rawIssue()], { nowMs: NOW });
    const internals = loadBackgroundInternals({
      watchedRepos: ["JSONbored/gittensory"],
      rankedCandidates: ranked,
    });

    const payload = await internals.loadIssueOpportunityContext({
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });

    expect(payload.status).toBe("ready");
    expect(payload.badge?.tier).toMatch(/High|Medium|Low/);
    expect(payload.badge?.why).toBeTruthy();
  });

  it("omits badge context when repo is watched but no ranked signal exists", async () => {
    const internals = loadBackgroundInternals({
      watchedRepos: ["JSONbored/gittensory"],
      rankedCandidates: [],
    });

    const payload = await internals.loadIssueOpportunityContext({
      owner: "JSONbored",
      repo: "gittensory",
      issueNumber: 145,
    });

    expect(payload.status).toBe("no-signal");
    expect(payload.badge).toBeNull();
  });

  it("loads a read-only calibration trend view from local snapshot storage", async () => {
    const internals = loadBackgroundInternals({
      snapshots: [{ observedAt: "2026-07-01T00:00:00.000Z", combinedAccuracy: 0.58 }],
    });
    const payload = await internals.loadCalibrationTrendView({});
    expect(payload.readOnly).toBe(true);
    expect(payload.view.pointCount).toBe(1);
    expect(payload.view.status).toBe("insufficient_history");
  });

  it("parses watched repos and ranked candidate JSON for options storage", () => {
    const internals = loadOptionsInternals();
    expect(internals.parseWatchedRepos("JSONbored/gittensory\nowner/repo")).toEqual([
      "JSONbored/gittensory",
      "owner/repo",
    ]);
    expect(internals.parseRankedCandidatesJson("[]")).toEqual([]);
    expect(internals.parseRankedCandidatesJson('[{"repoFullName":"a/b","issueNumber":1}]')).toHaveLength(1);
    expect(() => internals.parseRankedCandidatesJson("{")).toThrow();
    expect(() => internals.parseRankedCandidatesJson('{"not":"array"}')).toThrow();
  });
});

function createMockContainer() {
  const container = {
    hidden: false,
    innerHTML: "",
    removed: false,
    remove() {
      container.removed = true;
    },
  };
  return container;
}

function loadExtensionSupportScripts(vmContext: Record<string, unknown>) {
  new Script(badgeScript).runInContext(vmContext);
  new Script(calibrationTrendScript).runInContext(vmContext);
  new Script(calibrationPanelScript).runInContext(vmContext);
  new Script(panelRegistryScript).runInContext(vmContext);
}

function loadBadgeInternals() {
  const context: Record<string, unknown> = {
    __GITTENSORY_MINER_EXTENSION_TEST__: true,
  };
  context.globalThis = context;
  const vmContext = createContext(context);
  new Script(badgeScript).runInContext(vmContext);
  return vmContext.__gittensoryMinerOpportunityBadgeTestExports as {
    lookupRankedOpportunity: (ranked: unknown[], repoFullName: string, issueNumber: number) => Record<string, unknown> | null;
    formatOpportunityBadge: (entry: Record<string, unknown>) => { tier: string; score: string; why: string };
    renderOpportunityBadgeMarkup: (badge: { tier: string; score: string; why: string }) => string;
  };
}

function loadContentInternals() {
  const badge = loadBadgeInternals();
  const context: Record<string, unknown> = {
    __GITTENSORY_MINER_EXTENSION_TEST__: true,
    __gittensoryMinerOpportunityBadge: badge,
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
  loadExtensionSupportScripts(vmContext);
  new Script(contentScript).runInContext(vmContext);
  return vmContext.__gittensoryMinerContentInternals as {
    matchGitHubIssueTarget: (
      pathname: string,
    ) => { kind: "issue"; owner: string; repo: string; issueNumber: number } | null;
    renderOpportunityBadge: (container: ReturnType<typeof createMockContainer>, payload: unknown) => void;
  };
}

function loadBackgroundInternals({
  watchedRepos = [] as string[],
  rankedCandidates = [] as unknown[],
  snapshots = [] as unknown[],
} = {}) {
  const context: Record<string, unknown> = {
    __GITTENSORY_MINER_EXTENSION_TEST__: true,
    chrome: {
      storage: {
        sync: {
          get: async () => ({ watchedRepos, discoveryIndexUrl: "" }),
        },
        local: {
          get: async (keys: Record<string, unknown>) => {
            if (CALIBRATION_SNAPSHOTS_STORAGE_KEY in keys) {
              return { [CALIBRATION_SNAPSHOTS_STORAGE_KEY]: snapshots };
            }
            return { rankedCandidates };
          },
        },
      },
      runtime: { onMessage: { addListener: () => {} } },
    },
  };
  context.globalThis = context;
  const vmContext = createContext(context);
  loadExtensionSupportScripts(vmContext);
  const backgroundForTest = backgroundScript.replace(/^import\s+["'][^"']+["'];\s*/gm, "");
  new Script(backgroundForTest).runInContext(vmContext);
  return vmContext.__gittensoryMinerBackgroundInternals as {
    loadIssueOpportunityContext: (message: {
      owner: string;
      repo: string;
      issueNumber: number;
    }) => Promise<{
      status: string;
      badge: { tier: string; why: string } | null;
    }>;
    loadCalibrationTrendView: (message: Record<string, unknown>) => Promise<{
      readOnly: boolean;
      view: { pointCount: number; status: string };
    }>;
  };
}

function loadOptionsInternals() {
  const context: Record<string, unknown> = {
    __GITTENSORY_MINER_EXTENSION_TEST__: true,
    document: { querySelector: () => null },
    chrome: {
      storage: {
        sync: { get: async () => ({ watchedRepos: [], discoveryIndexUrl: "" }), set: async () => {} },
        local: { get: async () => ({ rankedCandidates: [] }), set: async () => {} },
      },
    },
    setTimeout: () => 0,
  };
  context.globalThis = context;
  const vmContext = createContext(context);
  new Script(optionsScript).runInContext(vmContext);
  return vmContext.__gittensoryMinerOptionsInternals as {
    parseWatchedRepos: (text: string) => string[];
    parseRankedCandidatesJson: (text: string) => unknown[];
  };
}
