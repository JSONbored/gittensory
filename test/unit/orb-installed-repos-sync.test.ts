import { describe, expect, it } from "vitest";
import { getRepository } from "../../src/db/repositories";
import { syncBrokeredInstalledRepos } from "../../src/orb/installed-repos-sync";
import { createTestEnv } from "../helpers/d1";

type Call = { url: string; init?: RequestInit | undefined };

/** Router-style fetch stub: the broker token exchange goes to `.../v1/orb/token`, everything else is treated
 *  as a GitHub `GET /installation/repositories` page request and answered from `pages` in order. */
function routedFetch(args: { tokenResponse: Response; pages: Response[] }): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let pageIndex = 0;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("/v1/orb/token")) return args.tokenResponse;
    const page = args.pages[pageIndex];
    pageIndex += 1;
    return page ?? Response.json({ repositories: [] });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function tokenResponse(installationId = 42): Response {
  return Response.json({ token: "ghs_x", installationId, expiresAt: "2026-06-25T09:00:00Z", permissions: { contents: "write" } });
}

function repoPayload(fullName: string) {
  const [owner, name] = fullName.split("/");
  return { full_name: fullName, name, owner: { login: owner }, private: false, html_url: `https://github.com/${fullName}`, default_branch: "main" };
}

describe("syncBrokeredInstalledRepos", () => {
  it("is a no-op outside broker mode (no enrollment secret)", async () => {
    const env = createTestEnv();
    const { fetchImpl, calls } = routedFetch({ tokenResponse: tokenResponse(), pages: [Response.json({ repositories: [repoPayload("owner/repo")] })] });
    const result = await syncBrokeredInstalledRepos(env, fetchImpl);
    expect(result).toEqual({ status: "skipped" });
    expect(calls).toHaveLength(0);
  });

  it("upserts every repo returned by GitHub as isInstalled, single page", async () => {
    const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_x" });
    const { fetchImpl } = routedFetch({
      tokenResponse: tokenResponse(42),
      pages: [Response.json({ repositories: [repoPayload("owner/repo-a"), repoPayload("owner/repo-b")] })],
    });
    const result = await syncBrokeredInstalledRepos(env, fetchImpl);
    expect(result).toEqual({ status: "synced", installationId: 42, repoCount: 2, removedCount: 0 });
    await expect(getRepository(env, "owner/repo-a")).resolves.toMatchObject({ isInstalled: true, installationId: 42 });
    await expect(getRepository(env, "owner/repo-b")).resolves.toMatchObject({ isInstalled: true, installationId: 42 });
  });

  it("paginates until a short page, following GitHub's own page-size convention", async () => {
    const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_x" });
    const fullPage = Response.json({ repositories: Array.from({ length: 100 }, (_, i) => repoPayload(`owner/repo-${i}`)) });
    const shortPage = Response.json({ repositories: [repoPayload("owner/repo-last")] });
    const { fetchImpl, calls } = routedFetch({ tokenResponse: tokenResponse(42), pages: [fullPage, shortPage] });
    const result = await syncBrokeredInstalledRepos(env, fetchImpl);
    expect(result).toEqual({ status: "synced", installationId: 42, repoCount: 101, removedCount: 0 });
    // token exchange + 2 pages
    expect(calls).toHaveLength(3);
    await expect(getRepository(env, "owner/repo-last")).resolves.toMatchObject({ isInstalled: true });
  });

  it("marks a previously-installed repo as no longer installed once GitHub stops returning it", async () => {
    const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_x" });
    // First sync: two repos installed.
    const first = routedFetch({ tokenResponse: tokenResponse(42), pages: [Response.json({ repositories: [repoPayload("owner/kept"), repoPayload("owner/removed")] })] });
    await syncBrokeredInstalledRepos(env, first.fetchImpl);
    await expect(getRepository(env, "owner/removed")).resolves.toMatchObject({ isInstalled: true });

    // Second sync: GitHub now only returns the kept repo.
    const second = routedFetch({ tokenResponse: tokenResponse(42), pages: [Response.json({ repositories: [repoPayload("owner/kept")] })] });
    const result = await syncBrokeredInstalledRepos(env, second.fetchImpl);
    expect(result).toEqual({ status: "synced", installationId: 42, repoCount: 1, removedCount: 1 });
    await expect(getRepository(env, "owner/kept")).resolves.toMatchObject({ isInstalled: true });
    await expect(getRepository(env, "owner/removed")).resolves.toMatchObject({ isInstalled: false, installationId: null });
  });

  it("fails safe (never throws) when the broker token exchange fails", async () => {
    const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_x" });
    const { fetchImpl } = routedFetch({ tokenResponse: new Response("nope", { status: 403 }), pages: [] });
    const result = await syncBrokeredInstalledRepos(env, fetchImpl);
    expect(result).toMatchObject({ status: "failed" });
    expect((result as { status: "failed"; reason: string }).reason).toMatch(/403/);
  });

  it("fails safe (never throws) when the GitHub installation-repos call errors", async () => {
    const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_x" });
    const { fetchImpl } = routedFetch({ tokenResponse: tokenResponse(42), pages: [new Response("rate limited", { status: 429 })] });
    const result = await syncBrokeredInstalledRepos(env, fetchImpl);
    expect(result).toMatchObject({ status: "failed", reason: "installation_repositories_http_429" });
  });

  it("falls back to a generic reason when a non-Error value rejects the fetch", async () => {
    const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_x" });
    const fetchImpl = (() => Promise.reject("not an Error instance")) as typeof fetch;
    const result = await syncBrokeredInstalledRepos(env, fetchImpl);
    expect(result).toEqual({ status: "failed", reason: "sync_failed" });
  });

  it("treats a missing repositories field on a page as an empty batch (ends pagination)", async () => {
    const env = createTestEnv({ ORB_ENROLLMENT_SECRET: "orbsec_x" });
    const { fetchImpl } = routedFetch({ tokenResponse: tokenResponse(42), pages: [Response.json({})] });
    const result = await syncBrokeredInstalledRepos(env, fetchImpl);
    expect(result).toEqual({ status: "synced", installationId: 42, repoCount: 0, removedCount: 0 });
  });
});
