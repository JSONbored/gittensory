import { describe, expect, it, vi, afterEach } from "vitest";
import {
  classifyAuthorTier,
  extractLinkedIssues,
  fetchAuthorMergedCount,
  prefetchEnrichmentGitHubContext,
  prefetchEnrichmentHistory,
  resolveEnrichmentGithubToken,
} from "../../src/review/enrichment-prefetch";
import { createInstallationToken } from "../../src/github/app";
import { createTestEnv } from "../helpers/d1";

vi.mock("../../src/github/app", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/github/app")>();
  return { ...actual, createInstallationToken: vi.fn() };
});

const mockedToken = vi.mocked(createInstallationToken);

describe("enrichment-prefetch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extractLinkedIssues handles defaults, explicit repos, dupes, and invalid refs", () => {
    expect(extractLinkedIssues(undefined, "org/app")).toEqual([]);
    expect(extractLinkedIssues("Fixes #12 and closes #34", "org/app")).toEqual([
      { repo: "org/app", number: 12 },
      { repo: "org/app", number: 34 },
    ]);
    expect(extractLinkedIssues("Closes other/repo#99", "org/app")).toEqual([
      { repo: "other/repo", number: 99 },
    ]);
    expect(
      extractLinkedIssues("Fixes #12 and fixes #12", "org/app"),
    ).toEqual([{ repo: "org/app", number: 12 }]);
    expect(extractLinkedIssues("Fixes #0 and closes #abc", "org/app")).toEqual(
      [],
    );
    const many = Array.from({ length: 10 }, (_, i) => `Fixes #${i + 1}`).join(
      " ",
    );
    expect(extractLinkedIssues(many, "org/app")).toHaveLength(8);
  });

  it("classifyAuthorTier buckets merged counts", () => {
    expect(classifyAuthorTier(null)).toBe("unknown");
    expect(classifyAuthorTier(2)).toBe("newcomer");
    expect(classifyAuthorTier(3)).toBe("established");
  });

  it("fetchAuthorMergedCount returns null on invalid repo, author, or API errors", async () => {
    await expect(
      fetchAuthorMergedCount("bad repo", "dev1", "token"),
    ).resolves.toBeNull();
    await expect(
      fetchAuthorMergedCount("org/app", "../evil", "token"),
    ).resolves.toBeNull();

    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(
      fetchAuthorMergedCount("org/app", "dev1", "token"),
    ).resolves.toBeNull();

    globalThis.fetch = vi.fn(async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;
    await expect(
      fetchAuthorMergedCount("org/app", "dev1", "token"),
    ).resolves.toBeNull();

    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(
      fetchAuthorMergedCount("org/app", "dev1", "token"),
    ).resolves.toBeNull();
  });

  it("fetchAuthorMergedCount reads search total_count with abort signal", async () => {
    globalThis.fetch = vi.fn(async (_url, init) => {
      expect(init).toEqual(
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      return {
        ok: true,
        json: async () => ({ total_count: 7 }),
      };
    }) as unknown as typeof fetch;
    const controller = new AbortController();
    await expect(
      fetchAuthorMergedCount("org/app", "@dev1", "token", controller.signal),
    ).resolves.toBe(7);
  });

  it("prefetchEnrichmentHistory returns null when author is missing", async () => {
    await expect(
      prefetchEnrichmentHistory({
        repoFullName: "org/app",
        author: undefined,
      }),
    ).resolves.toBeNull();
  });

  it("prefetchEnrichmentHistory without token parses linked issues only", async () => {
    const result = await prefetchEnrichmentHistory({
      repoFullName: "org/app",
      author: "dev1",
      body: "Fixes #42",
    });
    expect(result).toMatchObject({
      authorLogin: "dev1",
      authorTier: "unknown",
      linkedIssues: [{ number: 42, repo: "org/app", aligned: true }],
    });
  });

  it("prefetchEnrichmentHistory returns null without author and unknown-only author record", async () => {
    await expect(
      prefetchEnrichmentHistory({
        repoFullName: "org/app",
        author: "",
      }),
    ).resolves.toBeNull();

    await expect(
      prefetchEnrichmentHistory({
        repoFullName: "org/app",
        author: "solo",
        body: "",
      }),
    ).resolves.toMatchObject({
      authorLogin: "solo",
      authorTier: "unknown",
      linkedIssues: [],
      mergedPrCount: null,
    });
  });

  it("prefetchEnrichmentHistory with token fetches merged count and linked issue metadata", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes("/search/issues")) {
        return {
          ok: true,
          json: async () => ({ total_count: 5 }),
        } as Response;
      }
      if (String(url).includes("/issues/7")) {
        return {
          ok: true,
          json: async () => ({ state: "closed", title: "Done" }),
        } as Response;
      }
      if (String(url).includes("/issues/8")) {
        return {
          ok: true,
          json: async () => ({ state: "draft", title: "WIP" }),
        } as Response;
      }
      if (String(url).includes("/issues/9")) {
        return { ok: false, json: async () => ({}) } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const result = await prefetchEnrichmentHistory(
      {
        repoFullName: "org/app",
        author: "@dev1",
        body: "Fixes #7 and closes bad/repo#8 and closes org/app#9",
      },
      "token",
    );
    expect(result).toMatchObject({
      authorLogin: "dev1",
      mergedPrCount: 5,
      authorTier: "established",
    });
    expect(result!.linkedIssues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ number: 7, aligned: true, state: "closed" }),
        expect.objectContaining({ number: 8, aligned: false, state: "draft" }),
        expect.objectContaining({
          number: 9,
          aligned: false,
          state: null,
          title: null,
        }),
      ]),
    );
  });

  it("prefetchEnrichmentHistory marks malformed linked repos as unaligned", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ total_count: 0 }),
    })) as unknown as typeof fetch;
    const result = await prefetchEnrichmentHistory(
      {
        repoFullName: "org/app",
        author: "dev1",
        body: "Fixes owner/-bad#5",
      },
      "token",
    );
    expect(result!.linkedIssues[0]).toMatchObject({
      repo: "owner/-bad",
      aligned: false,
      state: null,
    });
  });

  it("resolveEnrichmentGithubToken prefers installation token then public token", async () => {
    mockedToken.mockResolvedValueOnce("install-token");
    const envWithInstall = createTestEnv({ GITHUB_PUBLIC_TOKEN: "public-token" });
    await expect(resolveEnrichmentGithubToken(envWithInstall, 42)).resolves.toBe(
      "install-token",
    );

    mockedToken.mockRejectedValueOnce(new Error("no app"));
    await expect(resolveEnrichmentGithubToken(envWithInstall, 42)).resolves.toBe(
      "public-token",
    );

    mockedToken.mockRejectedValueOnce(new Error("no app"));
    const bareEnv = createTestEnv({});
    await expect(resolveEnrichmentGithubToken(bareEnv, 42)).resolves.toBeUndefined();
    await expect(resolveEnrichmentGithubToken(bareEnv, null)).resolves.toBeUndefined();
  });

  it("prefetchEnrichmentGitHubContext fetches history and codeowners with installation token", async () => {
    mockedToken.mockResolvedValueOnce("install-token");
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes("/search/issues")) {
        return {
          ok: true,
          json: async () => ({ total_count: 1 }),
        } as Response;
      }
      if (String(url).includes("/contents/.github/CODEOWNERS")) {
        return {
          ok: true,
          text: async () => "src/ @team-leads\n",
        } as Response;
      }
      if (String(url).includes("/issues/7")) {
        return {
          ok: true,
          json: async () => ({ state: "open", title: "Bug" }),
        } as Response;
      }
      return { ok: false, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    const env = createTestEnv({});
    const result = await prefetchEnrichmentGitHubContext(env, {
      repoFullName: "org/app",
      author: "dev1",
      body: "Fixes #7",
      installationId: 42,
      files: [
        {
          repoFullName: "org/app",
          pullNumber: 1,
          path: "src/a.ts",
          additions: 1,
          deletions: 0,
          changes: 1,
          payload: {},
        },
      ],
    });
    expect(result.history).toMatchObject({
      authorLogin: "dev1",
      authorTier: "newcomer",
      linkedIssues: [{ number: 7, state: "open" }],
    });
    expect(result.codeowners).toEqual([
      { file: "src/a.ts", owners: ["@team-leads"] },
    ]);
    expect(mockedToken).toHaveBeenCalledWith(env, 42);
  });
});
