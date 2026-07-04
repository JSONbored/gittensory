import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { openRepoDocPullRequest } from "../../src/github/repo-doc-pr";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import * as repositoriesModule from "../../src/db/repositories";
import * as repoDocRenderModule from "../../src/review/repo-doc-render";
import { createTestEnv } from "../helpers/d1";

const REPO = "owner/widgets";
const [PROJECT, CHUNK_REPO] = ["owner", "widgets"];

function generateRsaPrivateKeyPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } }).privateKey;
}

function envWithKey() {
  return createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem() });
}

async function seedChunk(env: ReturnType<typeof createTestEnv>, path: string, text: string): Promise<void> {
  await env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (?,?,?,?,?,?,?)").bind(`${path}::0`, PROJECT, CHUNK_REPO, path, 0, "code", text).run();
}

async function seedProfileData(env: ReturnType<typeof createTestEnv>): Promise<void> {
  await seedChunk(env, "src/widget.ts", "export function widget() {}");
  await seedChunk(env, "package.json", JSON.stringify({ scripts: { build: "tsc", test: "vitest run", lint: "eslint ." } }));
}

async function seedInstalledRepo(env: ReturnType<typeof createTestEnv>, options: { defaultBranch?: string } = {}): Promise<void> {
  await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" }, ...(options.defaultBranch !== undefined ? { default_branch: options.defaultBranch } : {}) }, 555);
}

const TOKEN_URL = /\/access_tokens$/;

describe("openRepoDocPullRequest (#3000)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("declines when the repository is not installed", async () => {
    const result = await openRepoDocPullRequest(envWithKey(), REPO, "live");
    expect(result).toEqual({ opened: false, reason: "repository is not installed" });
  });

  it("declines when the repository is installed but carries no installation id", async () => {
    const env = envWithKey();
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" } });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: false, reason: "repository is not installed" });
  });

  it("declines with the profile's own reason when the repo has no RAG index yet", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: false, reason: "no RAG index configured or populated for this repo yet" });
  });

  it("declines defensively if content rendering ever returns null for a present profile", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    vi.spyOn(repoDocRenderModule, "renderRepoDocContent").mockReturnValueOnce(null);
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: false, reason: "no content rendered from profile" });
  });

  it("declines without minting an installation token or writing to GitHub when the action mode is not live", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    let tokenMinted = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) tokenMinted = true;
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "dry_run");
    expect(result).toEqual({ opened: false, reason: 'repo-doc pull request not opened: action mode is "dry_run"' });
    expect(tokenMinted).toBe(false);
  });

  it("returns the already-open PR without creating a new branch/commit", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    const calls: Array<{ method: string; url: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      calls.push({ method: init?.method ?? "GET", url });
      if (url.includes("/pulls?") && (init?.method ?? "GET") === "GET") {
        return Response.json([{ number: 7, html_url: "https://github.com/owner/widgets/pull/7" }]);
      }
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: true, reused: true, pullNumber: 7, url: "https://github.com/owner/widgets/pull/7", claudeMode: "symlink" });
    expect(calls.some((c) => c.url.includes("/git/trees"))).toBe(false);
  });

  it("opens a first-run pull request with a real CLAUDE.md symlink when the target tree accepts one", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : {} });
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "base-commit-sha", commit: { tree: { sha: "base-tree-sha" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "new-tree-sha" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "new-commit-sha" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({ ref: "refs/heads/gittensory/repo-docs" });
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 42, html_url: "https://github.com/owner/widgets/pull/42" });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: true, reused: false, pullNumber: 42, url: "https://github.com/owner/widgets/pull/42", claudeMode: "symlink" });

    const treeCall = calls.find((c) => c.url.endsWith("/git/trees"));
    expect(treeCall?.body).toMatchObject({ base_tree: "base-tree-sha" });
    const tree = treeCall?.body.tree as Array<{ path: string; mode: string; content: string }>;
    expect(tree).toEqual([
      { path: "AGENTS.md", mode: "100644", type: "blob", content: expect.stringContaining("# AGENTS.md") },
      { path: "CLAUDE.md", mode: "120000", type: "blob", content: "AGENTS.md" },
    ]);

    const commitCall = calls.find((c) => c.url.endsWith("/git/commits"));
    expect(commitCall?.body).toMatchObject({ tree: "new-tree-sha", parents: ["base-commit-sha"] });

    const refCall = calls.find((c) => c.url.endsWith("/git/refs"));
    expect(refCall?.body).toMatchObject({ ref: "refs/heads/gittensory/repo-docs", sha: "new-commit-sha" });

    const prCall = calls.find((c) => c.url.endsWith("/repos/owner/widgets/pulls") && c.method === "POST");
    expect(prCall?.body).toMatchObject({ head: "gittensory/repo-docs", base: "main", title: "docs: generate AGENTS.md and CLAUDE.md from repo profile" });
    expect(prCall?.body.body as string).toContain("Gittensory opened this pull request");
  });

  it("falls back to a byte-identical CLAUDE.md copy when the target repo rejects a symlink tree entry", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    let treeAttempts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "base-commit-sha", commit: { tree: { sha: "base-tree-sha" } } } });
      if (url.endsWith("/git/trees") && method === "POST") {
        treeAttempts += 1;
        if (treeAttempts === 1) return new Response("symlinks unsupported", { status: 422 });
        return Response.json({ sha: "copy-tree-sha" });
      }
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "copy-commit-sha" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({});
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 9, html_url: "https://github.com/owner/widgets/pull/9" });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: true, reused: false, pullNumber: 9, url: "https://github.com/owner/widgets/pull/9", claudeMode: "copy" });
    expect(treeAttempts).toBe(2);
  });

  it("fetches the default branch from GitHub when the stored repository record has none", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env);
    await seedProfileData(env);
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (url.endsWith("/repos/owner/widgets") && method === "GET") return Response.json({ default_branch: "trunk" });
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.endsWith("/branches/trunk")) return Response.json({ commit: { sha: "c", commit: { tree: { sha: "t" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "ts" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "cs" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({});
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 3, html_url: "https://github.com/owner/widgets/pull/3" });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: true, reused: false, pullNumber: 3, url: "https://github.com/owner/widgets/pull/3", claudeMode: "symlink" });
    expect(calls.some((c) => c === "GET https://api.github.com/repos/owner/widgets")).toBe(true);
  });

  it("reports a caught GitHub Error's message when both the symlink and copy tree attempts fail", async () => {
    const env = envWithKey();
    await seedInstalledRepo(env, { defaultBranch: "main" });
    await seedProfileData(env);
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      const method = init?.method ?? "GET";
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "c", commit: { tree: { sha: "t" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ message: "tree rejected entirely" }, { status: 422 });
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result.opened).toBe(false);
    expect((result as { opened: false; reason: string }).reason).toMatch(/tree rejected entirely/);
  });

  it("reports a generic message when a non-Error value is rejected partway through", async () => {
    const env = envWithKey();
    vi.spyOn(repositoriesModule, "getRepository").mockRejectedValueOnce("a non-Error rejection value");
    const result = await openRepoDocPullRequest(env, REPO, "live");
    expect(result).toEqual({ opened: false, reason: "unknown error opening repo-doc pull request" });
  });

  it("splits a bare repo name with no owner segment instead of throwing", async () => {
    const env = envWithKey();
    await env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (?,?,?,?,?,?,?)").bind("bare::0", "", "widgets", "src/widget.ts", 0, "code", "export function widget() {}").run();
    vi.spyOn(repositoriesModule, "getRepository").mockResolvedValueOnce({
      fullName: "widgets",
      owner: "",
      name: "widgets",
      installationId: 555,
      isInstalled: true,
      isRegistered: false,
      isPrivate: false,
      defaultBranch: "main",
    });
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      calls.push(url);
      return new Response("unexpected", { status: 500 });
    });
    const result = await openRepoDocPullRequest(env, "widgets", "live");
    expect(result.opened).toBe(false);
    expect(calls.some((url) => url.includes("/repos//widgets/pulls?"))).toBe(true);
  });
});
