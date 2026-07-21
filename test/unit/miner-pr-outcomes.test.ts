import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchContributorPrOutcomes,
  type ContributorPrOutcomes,
} from "../../packages/loopover-miner/lib/contributor-pr-outcomes-client.js";
import {
  parsePrOutcomesArgs,
  renderPrOutcomes,
  runPrOutcomes,
} from "../../packages/loopover-miner/lib/pr-outcomes-cli.js";

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

/** A temp config dir with a recorded loopover-mcp session (so resolveLoopoverBackendSession returns one). */
function sessionEnv(overrides: Record<string, string | undefined> = {}, profile: Record<string, unknown> = {}): NodeJS.ProcessEnv {
  const dir = tempDir("loopover-miner-pr-outcomes-session-");
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ profiles: { default: { apiUrl: "https://api.example", session: { token: "sess-token" }, ...profile } } }),
    { mode: 0o600 },
  );
  return { LOOPOVER_CONFIG_DIR: dir, ...overrides } as unknown as NodeJS.ProcessEnv;
}

/** A temp config dir with NO config file, so no session/login is ever resolved from disk. */
function emptyEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return { LOOPOVER_CONFIG_DIR: tempDir("loopover-miner-pr-outcomes-empty-"), ...overrides } as unknown as NodeJS.ProcessEnv;
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function throwingJsonResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error("not json");
    },
  } as unknown as Response;
}

const SAMPLE: ContributorPrOutcomes = {
  login: "octocat",
  count: 2,
  summary: "LoopOver post-merge outcomes for octocat: 2 merged PR(s).",
  outcomes: [
    {
      repoFullName: "acme/widgets",
      pullNumber: 12,
      outcome: "merged",
      attribution: "Merged PR #12",
      deeplink: "https://github.com/acme/widgets/pull/12",
      recordedAt: "2026-07-20T10:00:00Z",
    },
    {
      repoFullName: "acme/gadgets",
      pullNumber: null,
      outcome: "merged",
      attribution: "Merged",
      deeplink: "https://github.com/acme/gadgets",
      recordedAt: "2026-07-19T09:00:00Z",
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function captureLog() {
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((msg?: unknown) => void logs.push(String(msg)));
  return logs;
}

function captureError() {
  const errs: string[] = [];
  vi.spyOn(console, "error").mockImplementation((msg?: unknown) => void errs.push(String(msg)));
  return errs;
}

describe("fetchContributorPrOutcomes (#7658)", () => {
  it("throws a clear error when there is no logged-in session", async () => {
    await expect(fetchContributorPrOutcomes("octocat", { env: emptyEnv(), fetchImpl: vi.fn() })).rejects.toThrow(
      /not logged in/,
    );
  });

  it("throws when process.env (the default) carries no session either", async () => {
    // No `env` passed -> falls back to process.env; point its config dir at an empty temp dir so no session
    // is found on disk regardless of the host's real loopover config.
    vi.stubEnv("LOOPOVER_CONFIG_DIR", tempDir("loopover-miner-pr-outcomes-procenv-"));
    await expect(fetchContributorPrOutcomes("octocat", { fetchImpl: vi.fn() })).rejects.toThrow(/not logged in/);
  });

  it("GETs the endpoint with the session Bearer token and returns the payload", async () => {
    let capturedUrl = "";
    let capturedAuth: string | undefined;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedAuth = (init.headers as Record<string, string>).authorization;
      return jsonResponse(200, SAMPLE);
    });
    const result = await fetchContributorPrOutcomes("octocat", { env: sessionEnv(), fetchImpl, requestTimeoutMs: 1234 });
    expect(result).toEqual(SAMPLE);
    expect(capturedUrl).toBe("https://api.example/v1/contributors/octocat/pr-outcomes");
    expect(capturedAuth).toBe("Bearer sess-token");
  });

  it("appends the limit as a query parameter when provided", async () => {
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (url: string) => {
      capturedUrl = url;
      return jsonResponse(200, SAMPLE);
    });
    await fetchContributorPrOutcomes("oct/cat", { env: sessionEnv(), fetchImpl, limit: 5 });
    expect(capturedUrl).toBe("https://api.example/v1/contributors/oct%2Fcat/pr-outcomes?limit=5");
  });

  it("falls back to the global fetch when no fetchImpl is injected", async () => {
    const globalFetch = vi.fn(async () => jsonResponse(200, SAMPLE));
    vi.stubGlobal("fetch", globalFetch);
    const result = await fetchContributorPrOutcomes("octocat", { env: sessionEnv() });
    expect(result).toEqual(SAMPLE);
    expect(globalFetch).toHaveBeenCalledOnce();
  });

  it("throws on a non-2xx status", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: "not_found" }));
    await expect(fetchContributorPrOutcomes("octocat", { env: sessionEnv(), fetchImpl })).rejects.toThrow(
      /http_404/,
    );
  });

  it("throws when the body is not valid JSON", async () => {
    const fetchImpl = vi.fn(async () => throwingJsonResponse(200));
    await expect(fetchContributorPrOutcomes("octocat", { env: sessionEnv(), fetchImpl })).rejects.toThrow(
      /malformed/,
    );
  });

  it("throws when the body is JSON but not an object", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, "just a string"));
    await expect(fetchContributorPrOutcomes("octocat", { env: sessionEnv(), fetchImpl })).rejects.toThrow(
      /malformed/,
    );
  });
});

describe("parsePrOutcomesArgs (#7658)", () => {
  it("defaults to no login, no limit, plain output", () => {
    expect(parsePrOutcomesArgs([])).toEqual({ login: null, limit: undefined, json: false });
  });

  it("parses --login, --limit, and --json", () => {
    expect(parsePrOutcomesArgs(["--login", " octocat ", "--limit", "10", "--json"])).toEqual({
      login: "octocat",
      limit: 10,
      json: true,
    });
  });

  it("rejects a missing/flag-shaped/blank --login value", () => {
    expect(parsePrOutcomesArgs(["--login"])).toHaveProperty("error");
    expect(parsePrOutcomesArgs(["--login", "--json"])).toHaveProperty("error");
    expect(parsePrOutcomesArgs(["--login", "   "])).toHaveProperty("error");
  });

  it("rejects a missing/non-integer/out-of-range --limit", () => {
    expect(parsePrOutcomesArgs(["--limit"])).toHaveProperty("error");
    expect(parsePrOutcomesArgs(["--limit", "x"])).toHaveProperty("error");
    expect(parsePrOutcomesArgs(["--limit", "0"])).toHaveProperty("error");
    expect(parsePrOutcomesArgs(["--limit", "101"])).toHaveProperty("error");
    expect(parsePrOutcomesArgs(["--limit", "1.5"])).toHaveProperty("error");
  });

  it("accepts the boundary limits 1 and 100", () => {
    expect(parsePrOutcomesArgs(["--limit", "1"])).toMatchObject({ limit: 1 });
    expect(parsePrOutcomesArgs(["--limit", "100"])).toMatchObject({ limit: 100 });
  });

  it("rejects an unknown option", () => {
    expect(parsePrOutcomesArgs(["--bogus"])).toEqual({ error: "Unknown option: --bogus" });
  });
});

describe("renderPrOutcomes (#7658)", () => {
  it("renders the summary then one line per outcome, handling a null pull number", () => {
    const text = renderPrOutcomes(SAMPLE);
    expect(text).toContain("2 merged PR(s).");
    expect(text).toContain("acme/widgets#12  merged  2026-07-20T10:00:00Z  https://github.com/acme/widgets/pull/12");
    expect(text).toContain("acme/gadgets#?  merged");
  });

  it("shows the summary alone when there are no outcomes", () => {
    expect(renderPrOutcomes({ ...SAMPLE, count: 0, outcomes: [] })).toBe(SAMPLE.summary);
  });

  it("falls back to a note when there are neither outcomes nor a summary", () => {
    expect(renderPrOutcomes({ login: "x", count: 0, summary: "", outcomes: [] })).toBe("no merged PR outcomes");
  });

  it("treats a non-array outcomes field as empty", () => {
    const payload = { login: "x", count: 0, summary: "s", outcomes: undefined } as unknown as ContributorPrOutcomes;
    expect(renderPrOutcomes(payload)).toBe("s");
  });

  it("strips terminal escape sequences from server-supplied fields", () => {
    const nasty: ContributorPrOutcomes = {
      login: "x",
      count: 1,
      summary: "s",
      outcomes: [
        {
          repoFullName: `acme/${"\u001b"}[31mwidgets`,
          pullNumber: 1,
          outcome: "merged",
          attribution: "a",
          deeplink: "https://x",
          recordedAt: "2026-07-20",
        },
      ],
    };
    const rendered = renderPrOutcomes(nasty);
    expect(rendered).not.toContain("\u001b");
    expect(rendered).toContain("acme/widgets");
  });
});

describe("runPrOutcomes (#7658)", () => {
  it("reports a parse error as a non-zero exit", async () => {
    const errs = captureError();
    const code = await runPrOutcomes(["--bogus"], { env: emptyEnv() });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("Unknown option: --bogus");
  });

  it("errors when no login can be resolved from flag, session, or env", async () => {
    const errs = captureError();
    const code = await runPrOutcomes([], { env: emptyEnv(), fetchContributorPrOutcomes: vi.fn() });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("no login");
  });

  it("defaults to process.env when no env is passed", async () => {
    // No `env` option -> falls back to process.env; neutralize every login source deterministically.
    vi.stubEnv("LOOPOVER_CONFIG_DIR", tempDir("loopover-miner-pr-outcomes-cli-procenv-"));
    vi.stubEnv("LOOPOVER_LOGIN", "");
    vi.stubEnv("GITHUB_LOGIN", "");
    const errs = captureError();
    const code = await runPrOutcomes([], { fetchContributorPrOutcomes: vi.fn() });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("no login");
  });

  it("prints the rendered outcomes for an explicit --login", async () => {
    const logs = captureLog();
    const fetch = vi.fn(async () => SAMPLE);
    const code = await runPrOutcomes(["--login", "octocat"], { env: emptyEnv(), fetchContributorPrOutcomes: fetch });
    expect(code).toBe(0);
    expect(fetch).toHaveBeenCalledWith("octocat", expect.objectContaining({ env: expect.anything() }));
    expect(logs.join("\n")).toContain("acme/widgets#12  merged");
  });

  it("prints JSON and forwards --limit when --json is set", async () => {
    const logs = captureLog();
    const fetch = vi.fn(async () => SAMPLE);
    const code = await runPrOutcomes(["--login", "octocat", "--limit", "3", "--json"], {
      env: emptyEnv(),
      fetchContributorPrOutcomes: fetch,
    });
    expect(code).toBe(0);
    expect(fetch).toHaveBeenCalledWith("octocat", expect.objectContaining({ limit: 3 }));
    expect(JSON.parse(logs.join("\n"))).toEqual(SAMPLE);
  });

  it("defaults the login to the recorded loopover-mcp session login", async () => {
    const fetch = vi.fn(async () => SAMPLE);
    captureLog();
    const env = sessionEnv({}, { session: { token: "sess-token", login: "octocat" } });
    const code = await runPrOutcomes([], { env, fetchContributorPrOutcomes: fetch });
    expect(code).toBe(0);
    expect(fetch).toHaveBeenCalledWith("octocat", expect.anything());
  });

  it("falls back to LOOPOVER_LOGIN, then GITHUB_LOGIN", async () => {
    const fetch = vi.fn(async () => SAMPLE);
    captureLog();
    await runPrOutcomes([], { env: emptyEnv({ LOOPOVER_LOGIN: "from-loopover" }), fetchContributorPrOutcomes: fetch });
    expect(fetch).toHaveBeenLastCalledWith("from-loopover", expect.anything());
    await runPrOutcomes([], { env: emptyEnv({ GITHUB_LOGIN: "from-github" }), fetchContributorPrOutcomes: fetch });
    expect(fetch).toHaveBeenLastCalledWith("from-github", expect.anything());
  });

  it("drives the real client through an injected fetchImpl", async () => {
    const logs = captureLog();
    const fetchImpl = vi.fn(async () => jsonResponse(200, SAMPLE));
    const code = await runPrOutcomes(["--login", "octocat"], { env: sessionEnv(), fetchImpl });
    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(logs.join("\n")).toContain("acme/widgets#12  merged");
  });

  it("reports a client failure as a non-zero exit", async () => {
    const errs = captureError();
    const fetch = vi.fn(async () => {
      throw new Error("hosted pr-outcomes request failed: http_500");
    });
    const code = await runPrOutcomes(["--login", "octocat"], { env: emptyEnv(), fetchContributorPrOutcomes: fetch });
    expect(code).toBe(2);
    expect(errs.join("\n")).toContain("http_500");
  });
});
