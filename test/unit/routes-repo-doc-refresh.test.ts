import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { getRepositoryCollaboratorPermission } from "../../src/github/app";
import { upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

// #6743: POST /v1/repos/:owner/:repo/repo-docs/refresh — the REST mirror of the loopover_refresh_repo_docs
// MCP tool, write-access gated like the pending-actions decision route. performRepoDocRefresh's own
// opened/reused/not-enabled behavior is already exhaustively covered by test/unit/mcp-refresh-repo-docs.test.ts;
// these pin the ROUTE contract only: the gate, and that the runner's result reaches the response unmodified.
vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  getRepositoryCollaboratorPermission: vi.fn(),
}));
const mockedPermission = vi.mocked(getRepositoryCollaboratorPermission);

const REPO = "owner/widgets";
const PATH = "/v1/repos/owner/widgets/repo-docs/refresh";
const TOKEN_URL = /\/access_tokens$/;

function generateRsaPrivateKeyPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "pkcs1", format: "pem" } }).privateKey;
}

async function seedChunk(env: Env, path: string, text: string): Promise<void> {
  await env.DB.prepare("INSERT INTO repo_chunks (id, project, repo, path, chunk_index, kind, text) VALUES (?,?,?,?,?,?,?)").bind(`${path}::0`, "owner", "widgets", path, 0, "code", text).run();
}

describe("POST /v1/repos/:owner/:repo/repo-docs/refresh (#6743)", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => mockedPermission.mockReset());

  it("opens a repo-doc pull request and returns the runner's result unmodified", async () => {
    const app = createApp();
    const env = createTestEnv({ GITHUB_APP_PRIVATE_KEY: generateRsaPrivateKeyPem(), ADMIN_GITHUB_LOGINS: "operator-admin" });
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" }, default_branch: "main" }, 555);
    await upsertRepoFocusManifest(env, REPO, { repoDocGeneration: { enabled: true } });
    await seedChunk(env, "src/widget.ts", "export function widget() {}");
    await seedChunk(env, "package.json", JSON.stringify({ scripts: { build: "tsc" } }));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (TOKEN_URL.test(url)) return Response.json({ token: "t" });
      if (url.includes("/pulls?") && method === "GET") return Response.json([]);
      if (url.includes("/contents/") && method === "GET") return new Response("not found", { status: 404 });
      if (url.endsWith("/branches/main")) return Response.json({ commit: { sha: "base-commit-sha", commit: { tree: { sha: "base-tree-sha" } } } });
      if (url.endsWith("/git/trees") && method === "POST") return Response.json({ sha: "tree-sha" });
      if (url.endsWith("/git/commits") && method === "POST") return Response.json({ sha: "commit-sha" });
      if (url.endsWith("/git/refs") && method === "POST") return Response.json({});
      if (url.endsWith("/repos/owner/widgets/pulls") && method === "POST") return Response.json({ number: 101, html_url: "https://github.com/owner/widgets/pull/101" });
      return new Response("unexpected", { status: 500 });
    });
    const { token } = await createSessionForGitHubUser(env, { login: "operator-admin", id: 1 });

    const response = await app.request(PATH, { method: "POST", headers: { authorization: `Bearer ${token}` } }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ opened: true, reused: false, pullNumber: 101, url: "https://github.com/owner/widgets/pull/101" });
  });

  it("reports opened: false without touching GitHub when repo-doc generation is not enabled", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "operator-admin" });
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" } }, 555);
    const { token } = await createSessionForGitHubUser(env, { login: "operator-admin", id: 1 });

    const response = await app.request(PATH, { method: "POST", headers: { authorization: `Bearer ${token}` } }, env);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      opened: false,
      reason: "repo-doc generation is not enabled for this repository (.loopover.yml repoDocGeneration.enabled)",
    });
  });

  it("forbids a session without real write access to the repo", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    // The repo must be INSTALLED (not just registered) for a collaborator PR to earn "reader" the maintainer
    // app-role requireRepoWriteAccess checks first -- otherwise it 403s at that earlier gate instead of the
    // per-repo write-permission check this test targets (mirrors maintainer-activation.test.ts's seedRepo).
    await upsertInstallation(env, {
      installation: { id: 555, account: { login: "owner", id: 555, type: "User" }, repository_selection: "selected", permissions: { metadata: "read" }, events: ["repository"] },
    });
    await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" } }, 555);
    await env.DB.prepare("UPDATE repositories SET is_registered = 1 WHERE full_name = ?").bind(REPO).run();
    await upsertPullRequestFromGitHub(env, REPO, {
      number: 8,
      title: "docs tweak",
      state: "open",
      user: { login: "reader" },
      author_association: "COLLABORATOR",
      head: { sha: "def456", ref: "docs-2" },
      base: { ref: "main" },
      labels: [],
    });
    mockedPermission.mockResolvedValue("read");
    const { token } = await createSessionForGitHubUser(env, { login: "reader", id: 777 });

    const response = await app.request(PATH, { method: "POST", headers: { cookie: `loopover_session=${token}` } }, env);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "insufficient_repo_permission" });
  });
});
