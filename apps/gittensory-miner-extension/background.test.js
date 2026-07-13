import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Builds a fresh chrome mock. Every optional surface (alarms, onStartup, onInstalled, action +
 *  storage.onChanged) is individually toggleable so both sides of background.js's `if (chrome.X)`
 *  guards get exercised. */
function buildChromeMock({ withAlarms = true, withOnStartup = true, withOnInstalled = true, withActionAndOnChanged = true } = {}) {
  const messageListeners = [];
  const alarmListeners = [];
  const startupListeners = [];
  const installedListeners = [];
  const storageChangedListeners = [];

  const chrome = {
    runtime: {
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
    },
    storage: {
      sync: { get: vi.fn(async (defaults) => ({ ...defaults })) },
      local: {
        get: vi.fn(async (defaults) => ({ ...defaults })),
        set: vi.fn(async () => {}),
      },
    },
    action: withActionAndOnChanged
      ? { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) }
      : undefined,
  };
  if (withAlarms) {
    chrome.alarms = {
      create: vi.fn(),
      onAlarm: { addListener: (fn) => alarmListeners.push(fn) },
    };
  }
  if (withOnStartup) chrome.runtime.onStartup = { addListener: (fn) => startupListeners.push(fn) };
  if (withOnInstalled) chrome.runtime.onInstalled = { addListener: (fn) => installedListeners.push(fn) };
  if (withActionAndOnChanged) {
    chrome.storage.onChanged = { addListener: (fn) => storageChangedListeners.push(fn) };
  }

  return { chrome, messageListeners, alarmListeners, startupListeners, installedListeners, storageChangedListeners };
}

/** Imports a fresh copy of background.js (and its two auto-imported siblings) against the given
 *  chrome mock. Must use a dynamic import -- a static one would be hoisted above the globalThis
 *  assignments below and run before __GITTENSORY_MINER_EXTENSION_TEST__ / chrome are set. */
async function loadBackground(chromeMock) {
  vi.resetModules();
  globalThis.__GITTENSORY_MINER_EXTENSION_TEST__ = true;
  globalThis.chrome = chromeMock.chrome;
  await import("./background.js");
  return globalThis.__gittensoryMinerBackgroundInternals;
}

describe("background.js", () => {
  afterEach(() => {
    delete globalThis.chrome;
    vi.unstubAllGlobals();
  });

  describe("message routing", () => {
    it("responds synchronously to a ping message", async () => {
      const mock = buildChromeMock();
      const internals = await loadBackground(mock);
      const sendResponse = vi.fn();
      const keepChannelOpen = mock.messageListeners[0]({ type: internals.PING_MESSAGE }, {}, sendResponse);
      expect(sendResponse).toHaveBeenCalledWith({ ok: true, payload: { ready: true } });
      expect(keepChannelOpen).toBe(false);
    });

    it("ignores a message with no type", async () => {
      const mock = buildChromeMock();
      await loadBackground(mock);
      const sendResponse = vi.fn();
      expect(mock.messageListeners[0](null, {}, sendResponse)).toBe(false);
      expect(mock.messageListeners[0]({}, {}, sendResponse)).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    });

    it("returns true (async channel) and resolves an issue-context message", async () => {
      const mock = buildChromeMock();
      mock.chrome.storage.sync.get.mockResolvedValue({ watchedRepos: ["owner/repo"] });
      mock.chrome.storage.local.get.mockResolvedValue({ rankedCandidates: [], rankedCandidatesSavedAt: null });
      const internals = await loadBackground(mock);
      const sendResponse = vi.fn();
      const keepChannelOpen = mock.messageListeners[0](
        { type: internals.ISSUE_CONTEXT_MESSAGE, owner: "owner", repo: "repo", issueNumber: 1 },
        {},
        sendResponse,
      );
      expect(keepChannelOpen).toBe(true);
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
      expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it("responds with ok:false when the issue-context handler throws", async () => {
      const mock = buildChromeMock();
      mock.chrome.storage.sync.get.mockRejectedValue(new Error("boom"));
      const internals = await loadBackground(mock);
      const sendResponse = vi.fn();
      mock.messageListeners[0](
        { type: internals.ISSUE_CONTEXT_MESSAGE, owner: "o", repo: "r", issueNumber: 1 },
        {},
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "boom" });
    });

    it("returns true (async channel) and resolves a sync-ranked-candidates message", async () => {
      const mock = buildChromeMock();
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [] }) });
      const internals = await loadBackground(mock);
      const sendResponse = vi.fn();
      const keepChannelOpen = mock.messageListeners[0]({ type: internals.SYNC_RANKED_CANDIDATES_MESSAGE }, {}, sendResponse);
      expect(keepChannelOpen).toBe(true);
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
      expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
      delete globalThis.fetch;
    });

    it("ignores an unrecognized message type", async () => {
      const mock = buildChromeMock();
      await loadBackground(mock);
      const sendResponse = vi.fn();
      expect(mock.messageListeners[0]({ type: "some-other-message" }, {}, sendResponse)).toBe(false);
      expect(sendResponse).not.toHaveBeenCalled();
    });
  });

  describe("loadIssueOpportunityContext", () => {
    it("reports repo-not-watched when the repo isn't in watchedRepos", async () => {
      const mock = buildChromeMock();
      mock.chrome.storage.sync.get.mockResolvedValue({ watchedRepos: ["other/repo"] });
      const internals = await loadBackground(mock);
      const result = await internals.loadIssueOpportunityContext({ owner: "owner", repo: "repo", issueNumber: 1 });
      expect(result).toMatchObject({ watched: false, status: "repo-not-watched", badge: null });
    });

    it("reports no-signal when watched but no ranked entry exists", async () => {
      const mock = buildChromeMock();
      mock.chrome.storage.sync.get.mockResolvedValue({ watchedRepos: ["OWNER/REPO"] });
      mock.chrome.storage.local.get.mockResolvedValue({ rankedCandidates: [], rankedCandidatesSavedAt: null });
      const internals = await loadBackground(mock);
      const result = await internals.loadIssueOpportunityContext({ owner: "owner", repo: "repo", issueNumber: 1 });
      expect(result).toMatchObject({ watched: true, status: "no-signal", badge: null });
    });

    it("reports ready with a formatted badge when a ranked entry matches", async () => {
      const mock = buildChromeMock();
      mock.chrome.storage.sync.get.mockResolvedValue({ watchedRepos: ["owner/repo"] });
      mock.chrome.storage.local.get.mockResolvedValue({
        rankedCandidates: [{ repoFullName: "owner/repo", issueNumber: 1, rankScore: 0.9 }],
        rankedCandidatesSavedAt: 123,
      });
      const internals = await loadBackground(mock);
      const result = await internals.loadIssueOpportunityContext({ owner: "owner", repo: "repo", issueNumber: 1 });
      expect(result).toMatchObject({ watched: true, status: "ready", savedAt: 123 });
      expect(result.badge).toMatchObject({ tier: "High" });
    });
  });

  describe("loadMinerExtensionSettings", () => {
    it("trims and filters blank watched repos", async () => {
      const mock = buildChromeMock();
      mock.chrome.storage.sync.get.mockResolvedValue({ watchedRepos: [" owner/repo ", "", "  "] });
      const internals = await loadBackground(mock);
      expect(await internals.loadMinerExtensionSettings()).toEqual({ watchedRepos: ["owner/repo"] });
    });

    it("degrades a malformed (non-array) stored value to an empty list", async () => {
      const mock = buildChromeMock();
      mock.chrome.storage.sync.get.mockResolvedValue({ watchedRepos: "not-an-array" });
      const internals = await loadBackground(mock);
      expect(await internals.loadMinerExtensionSettings()).toEqual({ watchedRepos: [] });
    });
  });

  describe("loadRankedCandidates", () => {
    it("degrades a malformed rankedCandidates value to an empty array with a null savedAt", async () => {
      const mock = buildChromeMock();
      mock.chrome.storage.local.get.mockResolvedValue({ rankedCandidates: "nope", rankedCandidatesSavedAt: "nope" });
      const internals = await loadBackground(mock);
      expect(await internals.loadRankedCandidates()).toEqual({ rankedCandidates: [], savedAt: null });
    });

    it("passes through a well-formed value", async () => {
      const mock = buildChromeMock();
      mock.chrome.storage.local.get.mockResolvedValue({ rankedCandidates: [{ a: 1 }], rankedCandidatesSavedAt: 999 });
      const internals = await loadBackground(mock);
      expect(await internals.loadRankedCandidates()).toEqual({ rankedCandidates: [{ a: 1 }], savedAt: 999 });
    });
  });

  describe("loadMinerUiUrl", () => {
    it("falls back to the default when the stored URL is blank", async () => {
      const mock = buildChromeMock();
      mock.chrome.storage.sync.get.mockResolvedValue({ minerUiUrl: "   " });
      const internals = await loadBackground(mock);
      expect(await internals.loadMinerUiUrl()).toBe(internals.DEFAULT_MINER_UI_URL);
    });

    it("trims and returns a stored URL", async () => {
      const mock = buildChromeMock();
      mock.chrome.storage.sync.get.mockResolvedValue({ minerUiUrl: " http://example.test  " });
      const internals = await loadBackground(mock);
      expect(await internals.loadMinerUiUrl()).toBe("http://example.test");
    });
  });

  describe("syncRankedCandidatesFromMinerUi", () => {
    it("stores candidates and returns ok:true on a well-formed response", async () => {
      const mock = buildChromeMock();
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ a: 1 }, { b: 2 }] }) });
      const internals = await loadBackground(mock);
      const result = await internals.syncRankedCandidatesFromMinerUi();
      expect(result).toMatchObject({ ok: true, count: 2 });
      expect(mock.chrome.storage.local.set).toHaveBeenCalledWith(
        expect.objectContaining({ rankedCandidates: [{ a: 1 }, { b: 2 }] }),
      );
      delete globalThis.fetch;
    });

    it("returns ok:false without writing storage on a non-2xx response", async () => {
      const mock = buildChromeMock();
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      const internals = await loadBackground(mock);
      const result = await internals.syncRankedCandidatesFromMinerUi();
      expect(result).toMatchObject({ ok: false, error: "miner UI responded 500" });
      expect(mock.chrome.storage.local.set).not.toHaveBeenCalled();
      delete globalThis.fetch;
    });

    it("returns ok:false for a malformed payload shape", async () => {
      const mock = buildChromeMock();
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ nope: true }) });
      const internals = await loadBackground(mock);
      const result = await internals.syncRankedCandidatesFromMinerUi();
      expect(result).toMatchObject({ ok: false, error: "miner UI returned an unexpected payload shape" });
      delete globalThis.fetch;
    });

    it("returns ok:false with the error message when fetch itself throws", async () => {
      const mock = buildChromeMock();
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
      const internals = await loadBackground(mock);
      const result = await internals.syncRankedCandidatesFromMinerUi();
      expect(result).toMatchObject({ ok: false, error: "network down" });
      delete globalThis.fetch;
    });
  });

  describe("refreshToolbarBadge", () => {
    it("computes and applies the badge from stored rankedCandidates", async () => {
      const mock = buildChromeMock();
      mock.chrome.storage.local.get.mockResolvedValue({ rankedCandidates: [{}, {}] });
      const internals = await loadBackground(mock);
      await internals.refreshToolbarBadge();
      expect(mock.chrome.action.setBadgeText).toHaveBeenCalledWith({ text: "2" });
      expect(mock.chrome.action.setBadgeBackgroundColor).toHaveBeenCalledWith(expect.objectContaining({ color: expect.any(String) }));
    });

    it("swallows a chrome.storage failure instead of throwing", async () => {
      const mock = buildChromeMock();
      mock.chrome.storage.local.get.mockRejectedValue(new Error("storage error"));
      const internals = await loadBackground(mock);
      await expect(internals.refreshToolbarBadge()).resolves.toBeUndefined();
    });
  });

  describe("optional-API guards (alarms / onStartup / onInstalled / action+onChanged)", () => {
    it("wires the alarm + onAlarm listener when chrome.alarms is present, and filters by alarm name", async () => {
      const mock = buildChromeMock({ withAlarms: true });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [] }) });
      await loadBackground(mock);
      expect(mock.chrome.alarms.create).toHaveBeenCalledWith(
        "gittensory-miner:sync-ranked-candidates",
        expect.objectContaining({ periodInMinutes: expect.any(Number) }),
      );
      expect(mock.alarmListeners).toHaveLength(1);
      // A differently-named alarm must be ignored (no throw, no extra fetch assertions needed -- just exercises the branch).
      mock.alarmListeners[0]({ name: "some-other-alarm" });
      mock.alarmListeners[0]({ name: "gittensory-miner:sync-ranked-candidates" });
      delete globalThis.fetch;
    });

    it("skips alarm wiring entirely when chrome.alarms is absent", async () => {
      const mock = buildChromeMock({ withAlarms: false });
      await loadBackground(mock);
      expect(mock.alarmListeners).toHaveLength(0);
    });

    it("wires onStartup when present and skips it when absent", async () => {
      const withStartup = buildChromeMock({ withOnStartup: true });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [] }) });
      await loadBackground(withStartup);
      expect(withStartup.startupListeners).toHaveLength(1);

      const withoutStartup = buildChromeMock({ withOnStartup: false });
      await loadBackground(withoutStartup);
      expect(withoutStartup.startupListeners).toHaveLength(0);
      delete globalThis.fetch;
    });

    it("wires onInstalled when present and skips it when absent", async () => {
      const withInstalled = buildChromeMock({ withOnInstalled: true });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [] }) });
      await loadBackground(withInstalled);
      expect(withInstalled.installedListeners).toHaveLength(1);

      const withoutInstalled = buildChromeMock({ withOnInstalled: false });
      await loadBackground(withoutInstalled);
      expect(withoutInstalled.installedListeners).toHaveLength(0);
      delete globalThis.fetch;
    });

    it("paints the toolbar badge and wires storage.onChanged when action+onChanged are present", async () => {
      const mock = buildChromeMock({ withActionAndOnChanged: true });
      mock.chrome.storage.local.get.mockResolvedValue({ rankedCandidates: [{}] });
      await loadBackground(mock);
      await vi.waitFor(() => expect(mock.chrome.action.setBadgeText).toHaveBeenCalled());
      expect(mock.storageChangedListeners).toHaveLength(1);

      mock.chrome.action.setBadgeText.mockClear();
      // areaName !== "local" must be ignored.
      mock.storageChangedListeners[0]({ rankedCandidates: {} }, "sync");
      expect(mock.chrome.action.setBadgeText).not.toHaveBeenCalled();
      // a "local" change with no rankedCandidates key must also be ignored.
      mock.storageChangedListeners[0]({ someOtherKey: {} }, "local");
      expect(mock.chrome.action.setBadgeText).not.toHaveBeenCalled();
      // a genuine local rankedCandidates change triggers a repaint.
      mock.storageChangedListeners[0]({ rankedCandidates: {} }, "local");
      await vi.waitFor(() => expect(mock.chrome.action.setBadgeText).toHaveBeenCalled());
    });

    it("skips the toolbar-badge paint and onChanged wiring when action or onChanged is absent", async () => {
      const mock = buildChromeMock({ withActionAndOnChanged: false });
      await loadBackground(mock);
      expect(mock.storageChangedListeners).toHaveLength(0);
    });
  });
});
