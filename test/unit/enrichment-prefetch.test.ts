import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
  it("extractLinkedIssues parses default and explicit repo references", () => {
    expect(extractLinkedIssues("Fixes #12", "org/app")).toEqual([
      { repo: "org/app", number: 12 },
    ]);
    expect(extractLinkedIssues("Closes other/repo#99", "org/app")).toEqual([
      { repo: "other/repo", number: 99 },
    ]);
  });

  it("classifyAuthorTier buckets merged counts", () => {
    expect(classifyAuthorTier(null)).toBe("unknown");
    expect(classifyAuthorTier(2)).toBe("newcomer");
    expect(classifyAuthorTier(3)).toBe("established");
  });

  it("fetchAuthorMergedCount reads search total_count", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ total_count: 7 }),
    })) as unknown as typeof fetch;
    await expect(
      fetchAuthorMergedCount("org/app", "dev1", "token"),
    ).resolves.toBe(7);
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

    const bareEnv = createTestEnv({});
    await expect(resolveEnrichmentGithubToken(bareEnv, null)).resolves.toBeUndefined();
  });

  it("prefetchEnrichmentGitHubContext fetches history with installation token", async () => {
    mockedToken.mockResolvedValueOnce("install-token");
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes("/search/issues")) {
        return {
          ok: true,
          json: async () => ({ total_count: 1 }),
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
    });
    expect(result.history).toMatchObject({
      authorLogin: "dev1",
      authorTier: "newcomer",
      linkedIssues: [{ number: 7, state: "open" }],
    });
    expect(mockedToken).toHaveBeenCalledWith(env, 42);
  });
});
