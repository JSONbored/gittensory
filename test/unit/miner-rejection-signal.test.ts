import { describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import {
  resolveOwnRejectionHistory,
  resolveRejectionSignaled,
} from "../../packages/gittensory-miner/lib/rejection-signal.js";

// resolveRejectionSignaled fetches plain markdown text (AI-USAGE.md/CONTRIBUTING.md), never JSON, so
// json() is never actually called -- it's here only to satisfy SelfReviewContextFetch's response shape.
function textResponse(text: string | null, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async (): Promise<unknown> => {
      throw new Error("textResponse: json() is unused by resolveRejectionSignaled");
    },
    text: async () => text ?? "",
  };
}

/** Routes by URL substring; a null respond() throws to simulate a network failure. */
function routedFetch(routes: Record<string, () => ReturnType<typeof textResponse>>) {
  return async (url: string) => {
    for (const [substring, respond] of Object.entries(routes)) {
      if (url.includes(substring)) return respond();
    }
    return textResponse(null, 404);
  };
}

describe("resolveRejectionSignaled (#5132)", () => {
  it("returns true when AI-USAGE.md contains an explicit ban phrase", async () => {
    const fetchImpl = routedFetch({
      "AI-USAGE.md": () => textResponse("No AI-generated pull requests, please."),
      "CONTRIBUTING.md": () => textResponse("Welcome, contributors!"),
    });
    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });
    expect(result).toBe(true);
  });

  it("returns false when neither policy doc bans AI contributions", async () => {
    const fetchImpl = routedFetch({
      "AI-USAGE.md": () => textResponse("AI contributions are welcome here."),
      "CONTRIBUTING.md": () => textResponse("Welcome, contributors!"),
    });
    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });
    expect(result).toBe(false);
  });

  it("falls through to CONTRIBUTING.md's ban when AI-USAGE.md is empty", async () => {
    const fetchImpl = routedFetch({
      "AI-USAGE.md": () => textResponse(""),
      "CONTRIBUTING.md": () => textResponse("Do not submit AI-generated code."),
    });
    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });
    expect(result).toBe(true);
  });

  it("does not fetch CONTRIBUTING.md when a non-empty AI-USAGE.md decides the policy", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("AI-USAGE.md")) return textResponse("No AI-generated pull requests, please.");
      return textResponse("Do not download me");
    });

    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });

    expect(result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("AI-USAGE.md");
  });

  it("treats an oversized policy document as absent without reading its body", async () => {
    const text = vi.fn(async () => "No AI-generated pull requests, please.");
    const fetchImpl = routedFetch({
      "AI-USAGE.md": () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(129 * 1024) }),
        json: async (): Promise<unknown> => {
          throw new Error("json() is unused by resolveRejectionSignaled");
        },
        text,
      }),
      "CONTRIBUTING.md": () => textResponse("Welcome, contributors!"),
    });

    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });

    expect(result).toBe(false);
    expect(text).not.toHaveBeenCalled();
  });

  it("ignores a non-numeric content-length header and falls through to reading the body", async () => {
    const fetchImpl = routedFetch({
      "AI-USAGE.md": () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "not-a-number" }),
        json: async (): Promise<unknown> => {
          throw new Error("json() is unused by resolveRejectionSignaled");
        },
        text: async () => "No AI-generated pull requests, please.",
      }),
      "CONTRIBUTING.md": () => textResponse("Welcome, contributors!"),
    });

    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });

    expect(result).toBe(true);
  });

  it("treats an oversized non-streamed policy document as absent", async () => {
    const oversizedText = "a".repeat(129 * 1024);
    const fetchImpl = routedFetch({
      "AI-USAGE.md": () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async (): Promise<unknown> => {
          throw new Error("json() is unused by resolveRejectionSignaled");
        },
        text: async () => oversizedText,
      }),
      "CONTRIBUTING.md": () => textResponse("Do not submit AI-generated code."),
    });

    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });

    // AI-USAGE.md is treated as absent (oversized), so the verdict falls through to CONTRIBUTING.md's ban.
    expect(result).toBe(true);
  });

  it("cancels a streamed policy document once it exceeds the byte limit", async () => {
    let canceled = false;
    const chunk = new Uint8Array(65 * 1024);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });
    const fetchImpl = routedFetch({
      "AI-USAGE.md": () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: stream,
        json: async (): Promise<unknown> => {
          throw new Error("json() is unused by resolveRejectionSignaled");
        },
        text: async () => {
          throw new Error("streaming responses should not call text()");
        },
      }),
      "CONTRIBUTING.md": () => textResponse("Welcome, contributors!"),
    });

    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });

    expect(result).toBe(false);
    expect(canceled).toBe(true);
  });

  it("reads a streamed policy document to completion when it stays within the byte limit", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("No AI-generated "));
        controller.enqueue(encoder.encode("pull requests, please."));
        controller.close();
      },
    });
    const fetchImpl = routedFetch({
      "AI-USAGE.md": () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: stream,
        json: async (): Promise<unknown> => {
          throw new Error("json() is unused by resolveRejectionSignaled");
        },
        text: async () => {
          throw new Error("streaming responses should not call text()");
        },
      }),
      "CONTRIBUTING.md": () => textResponse("Welcome, contributors!"),
    });

    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });

    expect(result).toBe(true);
  });

  it("fails open to false when both docs 404", async () => {
    const fetchImpl = routedFetch({});
    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });
    expect(result).toBe(false);
  });

  it("fails open to false when a fetch throws (network error)", async () => {
    const fetchImpl = async () => {
      throw new Error("network unreachable");
    };
    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl });
    expect(result).toBe(false);
  });

  it("returns false for a malformed repoFullName, without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const result = await resolveRejectionSignaled("not-a-repo", { fetchImpl });
    expect(result).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses a custom rawContentBaseUrl when provided", async () => {
    const calledUrls: string[] = [];
    const fetchImpl = async (url: string) => {
      calledUrls.push(url);
      return textResponse(null, 404);
    };
    await resolveRejectionSignaled("acme/widgets", { fetchImpl, rawContentBaseUrl: "https://raw.example.internal" });
    expect(calledUrls.every((url) => url.startsWith("https://raw.example.internal/acme/widgets/HEAD/"))).toBe(true);
  });

  it("defaults to the real global fetch when fetchImpl is omitted", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => textResponse(null, 404));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const result = await resolveRejectionSignaled("acme/widgets");
      expect(result).toBe(false);
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── #5655: rejectionSignaled's SECOND trigger — this miner's own prior rejection on the repo ─────────────
function prJson(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => "", json: async () => body };
}
/** A fetch that maps a `/pulls/{n}` URL to a scripted PR payload (or a thrown/!ok failure). */
function pullsFetch(byNumber: Record<number, () => ReturnType<typeof prJson>>) {
  return async (url: string) => {
    const match = /\/pulls\/(\d+)/.exec(url);
    const n = match ? Number(match[1]) : NaN;
    const responder = byNumber[n];
    if (!responder) return prJson({}, 404);
    return responder();
  };
}
const closedUnmerged = { state: "closed", merged: false, closed_at: "2026-07-01T00:00:00Z" };
const mergedPr = { state: "closed", merged: true, merged_at: "2026-07-01T00:00:00Z" };
const openPr = { state: "open", merged: false };
const subs = (...nums: (number | null)[]) => () => nums.map((pullRequestNumber) => ({ pullRequestNumber }));

describe("resolveOwnRejectionHistory (#5655)", () => {
  const base = { githubToken: "t", apiBaseUrl: "https://api.example.test" };

  it("returns false for an unparseable repoFullName", async () => {
    expect(await resolveOwnRejectionHistory("not-a-repo", base)).toBe(false);
  });

  it("returns false when this miner has no recorded submissions on the repo", async () => {
    const listRecentOwnSubmissions = subs();
    expect(await resolveOwnRejectionHistory("acme/widgets", { ...base, listRecentOwnSubmissions, fetchImpl: pullsFetch({}) })).toBe(false);
  });

  it("returns true when ANY prior submission's PR is closed without a merge", async () => {
    const listRecentOwnSubmissions = subs(10, 11);
    const fetchImpl = pullsFetch({ 10: () => prJson(openPr), 11: () => prJson(closedUnmerged) });
    expect(await resolveOwnRejectionHistory("acme/widgets", { ...base, listRecentOwnSubmissions, fetchImpl })).toBe(true);
  });

  it("does NOT count a merged PR as a rejection (closed+merged is a success, not a rejection)", async () => {
    const listRecentOwnSubmissions = subs(10);
    const fetchImpl = pullsFetch({ 10: () => prJson(mergedPr) });
    expect(await resolveOwnRejectionHistory("acme/widgets", { ...base, listRecentOwnSubmissions, fetchImpl })).toBe(false);
  });

  it("does NOT count a still-open PR as a rejection", async () => {
    const listRecentOwnSubmissions = subs(10);
    const fetchImpl = pullsFetch({ 10: () => prJson(openPr) });
    expect(await resolveOwnRejectionHistory("acme/widgets", { ...base, listRecentOwnSubmissions, fetchImpl })).toBe(false);
  });

  it("skips submissions with no real pullRequestNumber (never fetches them)", async () => {
    const listRecentOwnSubmissions = subs(null, 0 as unknown as number);
    const fetchImpl = vi.fn(pullsFetch({}));
    expect(await resolveOwnRejectionHistory("acme/widgets", { ...base, listRecentOwnSubmissions, fetchImpl })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails open on an individual PR fetch (non-ok, or throwing) — one bad PR never blocks the others", async () => {
    const listRecentOwnSubmissions = subs(10, 11, 12);
    const fetchImpl = pullsFetch({
      10: () => prJson({}, 500), // non-ok → skipped
      11: () => { throw new Error("network"); }, // throws → skipped
      12: () => prJson(closedUnmerged), // still evaluated → rejection
    });
    expect(await resolveOwnRejectionHistory("acme/widgets", { ...base, listRecentOwnSubmissions, fetchImpl })).toBe(true);
  });

  it("fails open (false) + surfaces a warning when it cannot even list submissions", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listRecentOwnSubmissions = () => { throw new Error("db locked"); };
    expect(await resolveOwnRejectionHistory("acme/widgets", { ...base, listRecentOwnSubmissions, fetchImpl: pullsFetch({}) })).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).toContain("own_rejection_history_unavailable");
    warn.mockRestore();
  });

  it("surfaces the warning even when the listing failure is a non-Error throw", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const listRecentOwnSubmissions = () => { throw "db-string-fault"; };
    expect(await resolveOwnRejectionHistory("acme/widgets", { ...base, listRecentOwnSubmissions, fetchImpl: pullsFetch({}) })).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).toContain("db-string-fault");
    warn.mockRestore();
  });

  it("treats a non-array listing result as no submissions (defensive) and never fetches", async () => {
    const fetchImpl = vi.fn(pullsFetch({}));
    expect(
      await resolveOwnRejectionHistory("acme/widgets", { ...base, listRecentOwnSubmissions: (() => null) as never, fetchImpl }),
    ).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("bounds the PR-status fetches to maxSubmissions even when more submissions exist", async () => {
    const listRecentOwnSubmissions = vi.fn(subs(1, 2, 3, 4, 5));
    const fetchImpl = vi.fn(pullsFetch({ 1: () => prJson(openPr), 2: () => prJson(openPr) }));
    await resolveOwnRejectionHistory("acme/widgets", { ...base, listRecentOwnSubmissions, fetchImpl, maxSubmissions: 2 });
    expect(listRecentOwnSubmissions).toHaveBeenCalledWith({ repoFullName: "acme/widgets", limit: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("sends an authenticated, well-formed GET to the PR endpoint", async () => {
    const fetchImpl = vi.fn(pullsFetch({ 7: () => prJson(openPr) }));
    await resolveOwnRejectionHistory("acme/widgets", { ...base, listRecentOwnSubmissions: subs(7), fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as [string, { method: string; headers: Record<string, string> }];
    expect(url).toBe("https://api.example.test/repos/acme/widgets/pulls/7");
    expect(init.method).toBe("GET");
    expect(init.headers.authorization).toBe("Bearer t");
  });
});

describe("resolveRejectionSignaled combines both triggers (#5655)", () => {
  it("short-circuits to true on a policy ban WITHOUT any own-history fetch", async () => {
    const listRecentOwnSubmissions = vi.fn(subs(10));
    const fetchImpl = async (url: string) => {
      if (url.includes("AI-USAGE.md")) return prJson({}, 200) as never; // handled as text below
      return prJson(closedUnmerged);
    };
    const routed = routedFetch({
      "AI-USAGE.md": () => textResponse("No AI-generated pull requests, please."),
      "CONTRIBUTING.md": () => textResponse("Welcome!"),
    });
    void fetchImpl;
    const result = await resolveRejectionSignaled("acme/widgets", { fetchImpl: routed, listRecentOwnSubmissions });
    expect(result).toBe(true);
    expect(listRecentOwnSubmissions).not.toHaveBeenCalled();
  });

  it("returns true when there is no policy ban but a prior own submission was rejected", async () => {
    const combined = async (url: string) => {
      if (url.includes("AI-USAGE.md")) return textResponse("AI contributions welcome.") as never;
      if (url.includes("CONTRIBUTING.md")) return textResponse("Welcome!") as never;
      return prJson(closedUnmerged) as never;
    };
    const result = await resolveRejectionSignaled("acme/widgets", {
      fetchImpl: combined,
      listRecentOwnSubmissions: subs(10),
    });
    expect(result).toBe(true);
  });

  it("returns false when neither trigger fires", async () => {
    const combined = async (url: string) => {
      if (url.includes("AI-USAGE.md")) return textResponse("AI contributions welcome.") as never;
      if (url.includes("CONTRIBUTING.md")) return textResponse("Welcome!") as never;
      return prJson(mergedPr) as never;
    };
    const result = await resolveRejectionSignaled("acme/widgets", {
      fetchImpl: combined,
      listRecentOwnSubmissions: subs(10),
    });
    expect(result).toBe(false);
  });
});
