import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveOwnRejectionHistory } from "../../packages/gittensory-miner/lib/own-rejection-history.js";

afterEach(() => {
  vi.restoreAllMocks();
});

// A PR-status fetch stub: maps a PR number → the payload (or "throw" to simulate a fetch failure).
function prFetch(byNumber: Record<number, { state: string; merged?: boolean } | "throw" | "notok">) {
  return vi.fn(async (url: string, _init?: { method?: string; headers?: Record<string, string> }) => {
    const n = Number(url.split("/pulls/")[1]);
    const entry = byNumber[n];
    if (entry === "throw") throw new Error("network");
    if (entry === "notok") return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => entry };
  });
}

describe("resolveOwnRejectionHistory (#5655 — own prior-rejection trigger)", () => {
  it("returns true when a prior own submission on the repo is closed without merge", async () => {
    const listSubmissions = vi.fn(() => [{ pullRequestNumber: 7 }]);
    const fetchImpl = prFetch({ 7: { state: "closed", merged: false } });
    const result = await resolveOwnRejectionHistory("acme/widgets", { listSubmissions, fetchImpl, githubToken: "t" });
    expect(result).toBe(true);
    // The credential is sent as a bearer header, never logged.
    expect(fetchImpl.mock.calls[0]![1]!.headers).toMatchObject({ authorization: "Bearer t" });
  });

  it("returns false and fetches nothing when there are no prior submissions on the repo", async () => {
    const listSubmissions = vi.fn(() => []);
    const fetchImpl = prFetch({});
    const result = await resolveOwnRejectionHistory("acme/widgets", { listSubmissions, fetchImpl });
    expect(result).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    // No credential configured → no authorization header path exercised.
  });

  it("returns false when prior submissions exist but none are closed-without-merge (open or merged)", async () => {
    const listSubmissions = vi.fn(() => [{ pullRequestNumber: 1 }, { pullRequestNumber: 2 }]);
    const fetchImpl = prFetch({ 1: { state: "open" }, 2: { state: "closed", merged: true } });
    const result = await resolveOwnRejectionHistory("acme/widgets", { listSubmissions, fetchImpl });
    expect(result).toBe(false);
  });

  it("bounds the number of PR-status fetches to maxFetches", async () => {
    const listSubmissions = vi.fn(() =>
      [1, 2, 3, 4, 5].map((n) => ({ pullRequestNumber: n })),
    );
    const fetchImpl = prFetch({ 1: { state: "open" }, 2: { state: "open" }, 3: { state: "open" }, 4: { state: "open" }, 5: { state: "open" } });
    const result = await resolveOwnRejectionHistory("acme/widgets", { listSubmissions, fetchImpl, maxFetches: 2 });
    expect(result).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("skips submissions without a real pullRequestNumber and defaults the fetch cap", async () => {
    const listSubmissions = vi.fn(() => [{ pullRequestNumber: undefined }, { pullRequestNumber: 9 }]);
    const fetchImpl = prFetch({ 9: { state: "closed", merged: false } });
    const result = await resolveOwnRejectionHistory("acme/widgets", { listSubmissions, fetchImpl });
    expect(result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails open per-PR: an individual fetch failure never blocks the other submissions", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const listSubmissions = vi.fn(() => [{ pullRequestNumber: 1 }, { pullRequestNumber: 2 }]);
    const fetchImpl = prFetch({ 1: "throw", 2: { state: "closed", merged: false } });
    const result = await resolveOwnRejectionHistory("acme/widgets", { listSubmissions, fetchImpl });
    expect(result).toBe(true);
  });

  it("treats a non-OK PR response as a failed check (fail-open), not a rejection", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const listSubmissions = vi.fn(() => [{ pullRequestNumber: 1 }]);
    const fetchImpl = prFetch({ 1: "notok" });
    const result = await resolveOwnRejectionHistory("acme/widgets", { listSubmissions, fetchImpl });
    expect(result).toBe(false);
  });

  it("fails open to false on a wholesale submissions-store failure (degraded, never fabricated)", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const listSubmissions = vi.fn(() => {
      throw new Error("store unavailable");
    });
    const result = await resolveOwnRejectionHistory("acme/widgets", { listSubmissions });
    expect(result).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("returns false for a malformed repo full name (non-string, missing part, or extra part) without any lookup", async () => {
    const listSubmissions = vi.fn(() => [{ pullRequestNumber: 1 }]);
    expect(await resolveOwnRejectionHistory(undefined as unknown as string, { listSubmissions })).toBe(false);
    expect(await resolveOwnRejectionHistory("not-a-repo", { listSubmissions })).toBe(false);
    expect(await resolveOwnRejectionHistory("", { listSubmissions })).toBe(false);
    expect(await resolveOwnRejectionHistory("too/many/parts", { listSubmissions })).toBe(false);
    expect(listSubmissions).not.toHaveBeenCalled();
  });

  it("treats a non-positive maxFetches as the default cap", async () => {
    const listSubmissions = vi.fn(() => [{ pullRequestNumber: 1 }]);
    const fetchImpl = prFetch({ 1: { state: "closed", merged: false } });
    const result = await resolveOwnRejectionHistory("acme/widgets", { listSubmissions, fetchImpl, maxFetches: 0 });
    expect(result).toBe(true); // maxFetches 0 → falls back to the default cap, so the single PR is still checked
  });

  it("skips a null/blank submission entry defensively", async () => {
    const listSubmissions = vi.fn(() => [null, { pullRequestNumber: 5 }] as Array<{ pullRequestNumber?: number }>);
    const fetchImpl = prFetch({ 5: { state: "closed", merged: false } });
    const result = await resolveOwnRejectionHistory("acme/widgets", { listSubmissions, fetchImpl });
    expect(result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the global fetch when no fetchImpl is injected", async () => {
    const original = globalThis.fetch;
    const globalFetch = vi.fn(async () => ({ ok: true, json: async () => ({ state: "closed", merged: false }) }) as unknown as Response);
    globalThis.fetch = globalFetch as unknown as typeof fetch;
    try {
      const listSubmissions = vi.fn(() => [{ pullRequestNumber: 1 }]);
      const result = await resolveOwnRejectionHistory("acme/widgets", { listSubmissions });
      expect(result).toBe(true);
      expect(globalFetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("falls back to the real submissions store when no listSubmissions is injected (fails open to false here)", async () => {
    // No injected listSubmissions → the default listRecentOwnSubmissions is used. In this unit env it has no
    // recorded submissions for the repo (or is unavailable), so the check fails open to false without a fetch.
    const fetchImpl = prFetch({});
    const result = await resolveOwnRejectionHistory("acme/widgets", { fetchImpl });
    expect(result).toBe(false);
  });

  it("sends no authorization header when no credential is configured", async () => {
    const original = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const listSubmissions = vi.fn(() => [{ pullRequestNumber: 1 }]);
      const fetchImpl = prFetch({ 1: { state: "open" } });
      await resolveOwnRejectionHistory("acme/widgets", { listSubmissions, fetchImpl });
      expect(fetchImpl.mock.calls[0]![1]!.headers).not.toHaveProperty("authorization");
    } finally {
      if (original === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = original;
    }
  });
});
