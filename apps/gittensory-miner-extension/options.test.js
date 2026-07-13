import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FORM_HTML = `
  <form id="settings">
    <textarea id="watchedRepos" name="watchedRepos"></textarea>
    <input id="minerUiUrl" name="minerUiUrl" type="url" />
    <textarea id="rankedCandidatesJson" name="rankedCandidatesJson"></textarea>
    <button type="submit">Save</button>
    <button type="button" id="syncNow">Sync ranked candidates now</button>
  </form>
  <p id="status" role="status"></p>
`;

function buildChromeMock() {
  return {
    storage: {
      sync: {
        get: vi.fn(async (defaults) => ({ ...defaults })),
        set: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
      local: {
        get: vi.fn(async (defaults) => ({ ...defaults })),
        set: vi.fn(async () => {}),
      },
    },
    runtime: { sendMessage: vi.fn() },
  };
}

/** Fresh import of options.js. `mountForm` controls whether options.html's form is present before
 *  import -- options.js takes a different top-level branch when it's absent (unit-test harness). */
async function loadOptions({ mountForm = true, chrome = buildChromeMock() } = {}) {
  vi.resetModules();
  document.body.innerHTML = mountForm ? FORM_HTML : "";
  globalThis.__GITTENSORY_MINER_EXTENSION_TEST__ = true;
  globalThis.chrome = chrome;
  await import("./options.js");
  return { internals: globalThis.__gittensoryMinerOptionsInternals, chrome };
}

describe("options.js", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    delete globalThis.chrome;
  });

  describe("parseWatchedRepos", () => {
    it("splits on newlines and commas, trimming and dropping blanks", async () => {
      const { internals } = await loadOptions({ mountForm: false });
      expect(internals.parseWatchedRepos("owner/a\n owner/b ,owner/c\n\n")).toEqual([
        "owner/a",
        "owner/b",
        "owner/c",
      ]);
    });

    it("returns an empty array for a nullish/blank input", async () => {
      const { internals } = await loadOptions({ mountForm: false });
      expect(internals.parseWatchedRepos(undefined)).toEqual([]);
      expect(internals.parseWatchedRepos("   ")).toEqual([]);
    });
  });

  describe("parseRankedCandidatesJson", () => {
    it("returns an empty array for blank text", async () => {
      const { internals } = await loadOptions({ mountForm: false });
      expect(internals.parseRankedCandidatesJson("  ")).toEqual([]);
    });

    it("parses a well-formed JSON array", async () => {
      const { internals } = await loadOptions({ mountForm: false });
      expect(internals.parseRankedCandidatesJson('[{"a":1}]')).toEqual([{ a: 1 }]);
    });

    it("throws for malformed JSON", async () => {
      const { internals } = await loadOptions({ mountForm: false });
      expect(() => internals.parseRankedCandidatesJson("{not json")).toThrow();
    });

    it("throws when the parsed JSON is not an array", async () => {
      const { internals } = await loadOptions({ mountForm: false });
      expect(() => internals.parseRankedCandidatesJson('{"a":1}')).toThrow("must be an array");
    });

    it("throws when the payload exceeds the byte-size limit", async () => {
      const { internals } = await loadOptions({ mountForm: false });
      const huge = `[${"1,".repeat(internals.MAX_RANKED_CANDIDATES_JSON_BYTES)}1]`;
      expect(() => internals.parseRankedCandidatesJson(huge)).toThrow(/too large/);
    });
  });

  describe("normalizeMinerUiUrl", () => {
    it("falls back to the default for blank input", async () => {
      const { internals } = await loadOptions({ mountForm: false });
      expect(internals.normalizeMinerUiUrl("  ")).toBe(internals.DEFAULT_MINER_UI_URL);
      expect(internals.normalizeMinerUiUrl(undefined)).toBe(internals.DEFAULT_MINER_UI_URL);
    });

    it("trims and returns a non-blank URL", async () => {
      const { internals } = await loadOptions({ mountForm: false });
      expect(internals.normalizeMinerUiUrl(" http://x.test ")).toBe("http://x.test");
    });
  });

  describe("removeLegacyDiscoveryIndexUrl", () => {
    it("removes the legacy sync key", async () => {
      const { internals, chrome } = await loadOptions({ mountForm: false });
      await internals.removeLegacyDiscoveryIndexUrl();
      expect(chrome.storage.sync.remove).toHaveBeenCalledWith("discoveryIndexUrl");
    });
  });

  describe("without the options form mounted (unit-test harness path)", () => {
    it("does not throw when the form elements are absent", async () => {
      await expect(loadOptions({ mountForm: false })).resolves.toBeDefined();
    });
  });

  describe("with the options form mounted", () => {
    it("hydrates the form from chrome.storage on load", async () => {
      const chrome = buildChromeMock();
      chrome.storage.sync.get.mockResolvedValue({ watchedRepos: ["owner/a", "owner/b"], minerUiUrl: "http://x.test" });
      chrome.storage.local.get.mockResolvedValue({ rankedCandidates: [{ a: 1 }] });
      await loadOptions({ chrome });
      await vi.waitFor(() => expect(document.getElementById("watchedRepos").value).toBe("owner/a\nowner/b"));
      expect(document.getElementById("minerUiUrl").value).toBe("http://x.test");
      expect(document.getElementById("rankedCandidatesJson").value).toContain('"a": 1');
    });

    it("shows an empty ranked-candidates field when storage has none", async () => {
      const chrome = buildChromeMock();
      await loadOptions({ chrome });
      await vi.waitFor(() => expect(chrome.storage.local.get).toHaveBeenCalled());
      expect(document.getElementById("rankedCandidatesJson").value).toBe("");
    });

    it("saves the form on submit and shows a save-with-candidates status", async () => {
      const chrome = buildChromeMock();
      await loadOptions({ chrome });
      await vi.waitFor(() => expect(chrome.storage.sync.get).toHaveBeenCalled());

      document.getElementById("watchedRepos").value = "owner/repo";
      document.getElementById("rankedCandidatesJson").value = '[{"repoFullName":"owner/repo","issueNumber":1}]';
      document.getElementById("settings").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));

      await vi.waitFor(() =>
        expect(chrome.storage.local.set).toHaveBeenCalledWith(
          expect.objectContaining({ rankedCandidates: [{ repoFullName: "owner/repo", issueNumber: 1 }] }),
        ),
      );
      await vi.waitFor(() => expect(document.getElementById("status").textContent).toContain("1 ranked candidate"));
    });

    it("saves the form on submit and shows a watching-only status when no candidates were pasted", async () => {
      const chrome = buildChromeMock();
      await loadOptions({ chrome });
      await vi.waitFor(() => expect(chrome.storage.sync.get).toHaveBeenCalled());

      document.getElementById("watchedRepos").value = "owner/repo";
      document.getElementById("settings").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));

      await vi.waitFor(() => expect(document.getElementById("status").textContent).toBe("Watching 1 repository(ies)."));
    });

    it("shows the parse error instead of saving when the pasted JSON is malformed", async () => {
      const chrome = buildChromeMock();
      await loadOptions({ chrome });
      await vi.waitFor(() => expect(chrome.storage.sync.get).toHaveBeenCalled());
      chrome.storage.local.set.mockClear();

      document.getElementById("rankedCandidatesJson").value = "{not json";
      document.getElementById("settings").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));

      await vi.waitFor(() => expect(document.getElementById("status").textContent).not.toBe(""));
      expect(chrome.storage.local.set).not.toHaveBeenCalled();
    });

    it("sync-now saves the URL, requests a sync, and shows the synced count on success", async () => {
      const chrome = buildChromeMock();
      chrome.runtime.sendMessage.mockResolvedValue({
        payload: { ok: true, count: 3, minerUiUrl: "http://miner.test" },
      });
      await loadOptions({ chrome });
      await vi.waitFor(() => expect(chrome.storage.sync.get).toHaveBeenCalled());

      document.getElementById("minerUiUrl").value = "http://miner.test";
      document.getElementById("syncNow").dispatchEvent(new window.Event("click", { bubbles: true }));

      await vi.waitFor(() =>
        expect(document.getElementById("status").textContent).toBe("Synced 3 ranked candidate(s) from http://miner.test."),
      );
    });

    it("sync-now shows the paste-fallback message when the background reports a failure", async () => {
      const chrome = buildChromeMock();
      chrome.runtime.sendMessage.mockResolvedValue({
        payload: { ok: false, error: "miner UI responded 500", minerUiUrl: "http://miner.test" },
      });
      await loadOptions({ chrome });
      await vi.waitFor(() => expect(chrome.storage.sync.get).toHaveBeenCalled());

      document.getElementById("syncNow").dispatchEvent(new window.Event("click", { bubbles: true }));

      await vi.waitFor(() =>
        expect(document.getElementById("status").textContent).toContain("Could not reach the miner UI"),
      );
      expect(document.getElementById("status").textContent).toContain("Falling back to the pasted JSON below");
    });

    it("sync-now shows the raw error message when sendMessage itself rejects", async () => {
      const chrome = buildChromeMock();
      chrome.runtime.sendMessage.mockRejectedValue(new Error("channel closed"));
      await loadOptions({ chrome });
      await vi.waitFor(() => expect(chrome.storage.sync.get).toHaveBeenCalled());

      document.getElementById("syncNow").dispatchEvent(new window.Event("click", { bubbles: true }));

      await vi.waitFor(() => expect(document.getElementById("status").textContent).toBe("channel closed"));
    });

    it("clears the status message after its timeout", async () => {
      vi.useFakeTimers();
      try {
        const chrome = buildChromeMock();
        await loadOptions({ chrome });
        document.getElementById("watchedRepos").value = "owner/repo";
        document.getElementById("settings").dispatchEvent(new window.Event("submit", { cancelable: true, bubbles: true }));
        await vi.waitFor(() => expect(document.getElementById("status").textContent).not.toBe(""), {
          timeout: 1000,
        });
        await vi.advanceTimersByTimeAsync(3000);
        expect(document.getElementById("status").textContent).toBe("");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
