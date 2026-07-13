import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const BADGE_SELECTOR = "[data-gittensory-miner-opportunity-badge]";

function stubBadgeApi() {
  globalThis.__gittensoryMinerOpportunityBadge = {
    formatLastSyncedLabel: (savedAt) => (savedAt ? `last synced ${savedAt}` : null),
    renderOpportunityBadgeMarkup: (badge, label) =>
      badge ? `<strong>${badge.tier}</strong>${label ? `<span>${label}</span>` : ""}` : "",
  };
}

/** Fresh import of content.js at a given pathname, with chrome.runtime.sendMessage mocked to
 *  resolve with `sendMessageResult`. Must be a dynamic import so the pathname/mock setup below
 *  runs before content.js's top-level auto-mount logic reads them. */
async function loadContentAt(pathname, sendMessageResult) {
  vi.resetModules();
  window.history.pushState({}, "", pathname);
  globalThis.__GITTENSORY_MINER_EXTENSION_TEST__ = true;
  globalThis.chrome = { runtime: { sendMessage: vi.fn().mockResolvedValue(sendMessageResult) } };
  stubBadgeApi();
  await import("./content.js");
  return globalThis.__gittensoryMinerContentInternals;
}

describe("content.js", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    delete globalThis.chrome;
    delete globalThis.__gittensoryMinerOpportunityBadge;
  });

  describe("matchGitHubIssueTarget", () => {
    it("matches a GitHub issue URL", async () => {
      const internals = await loadContentAt("/", { ok: false });
      expect(internals.matchGitHubIssueTarget("/octocat/hello-world/issues/42")).toEqual({
        kind: "issue",
        owner: "octocat",
        repo: "hello-world",
        issueNumber: 42,
      });
    });

    it("matches with a trailing slash or trailing segment", async () => {
      const internals = await loadContentAt("/", { ok: false });
      expect(internals.matchGitHubIssueTarget("/octocat/hello-world/issues/42/")).toMatchObject({ issueNumber: 42 });
    });

    it("returns null for a non-issue path", async () => {
      const internals = await loadContentAt("/", { ok: false });
      expect(internals.matchGitHubIssueTarget("/octocat/hello-world/pulls/42")).toBeNull();
      expect(internals.matchGitHubIssueTarget("/octocat/hello-world")).toBeNull();
      expect(internals.matchGitHubIssueTarget(null)).toBeNull();
    });
  });

  describe("findIssueSidebar", () => {
    it("prefers #partial-discussion-sidebar over the other fallbacks", async () => {
      const internals = await loadContentAt("/", { ok: false });
      document.body.innerHTML = `
        <div id="partial-discussion-sidebar"></div>
        <div data-testid="issue-sidebar"></div>
      `;
      expect(internals.findIssueSidebar()?.id).toBe("partial-discussion-sidebar");
    });

    it("falls back through the remaining selectors in order", async () => {
      const internals = await loadContentAt("/", { ok: false });
      document.body.innerHTML = `<div class="Layout-sidebar"></div>`;
      expect(internals.findIssueSidebar()?.className).toBe("Layout-sidebar");
    });

    it("returns null when nothing matches", async () => {
      const internals = await loadContentAt("/", { ok: false });
      document.body.innerHTML = `<div></div>`;
      expect(internals.findIssueSidebar()).toBeNull();
    });
  });

  describe("renderOpportunityBadge", () => {
    it("removes the container when the payload isn't watched", async () => {
      const internals = await loadContentAt("/", { ok: false });
      const container = document.createElement("aside");
      document.body.appendChild(container);
      internals.renderOpportunityBadge(container, { watched: false });
      expect(document.body.contains(container)).toBe(false);
    });

    it("removes the container when watched but there's no badge", async () => {
      const internals = await loadContentAt("/", { ok: false });
      const container = document.createElement("aside");
      document.body.appendChild(container);
      internals.renderOpportunityBadge(container, { watched: true, badge: null });
      expect(document.body.contains(container)).toBe(false);
    });

    it("removes the container when the badge API produces no markup", async () => {
      const internals = await loadContentAt("/", { ok: false });
      globalThis.__gittensoryMinerOpportunityBadge.renderOpportunityBadgeMarkup = () => "";
      const container = document.createElement("aside");
      document.body.appendChild(container);
      internals.renderOpportunityBadge(container, { watched: true, badge: { tier: "High" } });
      expect(document.body.contains(container)).toBe(false);
    });

    it("un-hides the container and fills it with markup when ready, including the last-synced label", async () => {
      const internals = await loadContentAt("/", { ok: false });
      const container = document.createElement("aside");
      container.hidden = true;
      document.body.appendChild(container);
      internals.renderOpportunityBadge(container, { watched: true, badge: { tier: "High" }, savedAt: 555 }, 1000);
      expect(container.hidden).toBe(false);
      expect(container.innerHTML).toContain("High");
      expect(container.innerHTML).toContain("last synced 555");
    });
  });

  describe("auto-mount on import", () => {
    it("mounts and populates the badge on a watched, ready issue page", async () => {
      await loadContentAt("/octocat/hello-world/issues/42", {
        ok: true,
        payload: { watched: true, badge: { tier: "High" }, savedAt: 42 },
      });
      await vi.waitFor(() => {
        const el = document.querySelector(BADGE_SELECTOR);
        expect(el).not.toBeNull();
        expect(el.hidden).toBe(false);
      });
    });

    it("mounts into the issue sidebar host when present, otherwise floats in the body", async () => {
      document.body.innerHTML = `<div id="partial-discussion-sidebar"></div>`;
      await loadContentAt("/octocat/hello-world/issues/42", {
        ok: true,
        payload: { watched: true, badge: { tier: "High" } },
      });
      await vi.waitFor(() => {
        const el = document.querySelector(BADGE_SELECTOR);
        expect(el).not.toBeNull();
        expect(document.getElementById("partial-discussion-sidebar").contains(el)).toBe(true);
        expect(el.className).not.toContain("--floating");
      });
    });

    it("removes the mounted container when the background responds ok:false", async () => {
      await loadContentAt("/octocat/hello-world/issues/42", { ok: false });
      await vi.waitFor(() => expect(document.querySelector(BADGE_SELECTOR)).toBeNull());
    });

    it("does not mount anything on a non-issue page", async () => {
      await loadContentAt("/octocat/hello-world/pulls/1", { ok: false });
      expect(document.querySelector(BADGE_SELECTOR)).toBeNull();
    });

    it("does not mount a second badge if one is already present", async () => {
      document.body.innerHTML = `<aside ${"data-gittensory-miner-opportunity-badge"}="true"></aside>`;
      await loadContentAt("/octocat/hello-world/issues/42", { ok: false });
      expect(document.querySelectorAll(BADGE_SELECTOR)).toHaveLength(1);
    });
  });
});
