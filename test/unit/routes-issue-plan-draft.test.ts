import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { getRepositoryCollaboratorPermission } from "../../src/github/app";
import { createTestEnv } from "../helpers/d1";

const PLAN_PATH = "/v1/repos/JSONbored/loopover/issue-plan-drafts/generate";
const OWNED_REPO_PATH = "/v1/repos/repo-owner/owned-repo/issue-plan-drafts/generate";
// AI planning is gated behind the fleet AI switches; enable them so the route reaches an "ok" (not "disabled")
// result and returns real drafts, exercising goal forwarding rather than the early kill-switch return.
const AI_ENABLED = { AI_SUMMARIES_ENABLED: "true", AI_PUBLIC_COMMENTS_ENABLED: "true" };

vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  getRepositoryCollaboratorPermission: vi.fn(),
}));
const mockedPermission = vi.mocked(getRepositoryCollaboratorPermission);

/** Mirrors mcp-plan-repo-issues.test.ts: the AI binding returns a single planned issue as JSON. */
function planningAi() {
  return { run: async () => ({ response: JSON.stringify({ issues: [{ title: "Add retry to the sync job", body: "Retries transient failures with backoff." }] }) }) } as unknown as Ai;
}

function apiHeaders(env: Env): Record<string, string> {
  return {
    authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`,
    "content-type": "application/json",
  };
}

async function seedRegisteredInstalledRepo(env: Env, installationId: number, owner: string, name: string): Promise<void> {
  await upsertInstallation(env, {
    installation: {
      id: installationId,
      account: { login: owner, id: installationId, type: "User" },
      repository_selection: "selected",
      permissions: { metadata: "read", contents: "read" },
      events: ["repository"],
    },
  });
  await upsertRepositoryFromGitHub(
    env,
    { name, full_name: `${owner}/${name}`, private: false, owner: { login: owner } },
    installationId,
  );
  await env.DB.prepare("UPDATE repositories SET is_registered = 1 WHERE full_name = ?")
    .bind(`${owner}/${name}`)
    .run();
}

describe("issue-plan-drafts route auth (#7764)", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => mockedPermission.mockReset());

  it("rejects unauthenticated access", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(PLAN_PATH, { method: "POST", body: "{}" }, env);
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "unauthorized" });
  });

  it("rejects unauthorized session access", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "jsonbored" });
    const { token } = await createSessionForGitHubUser(env, { login: "new-user", id: 2468 });
    const response = await app.request(
      PLAN_PATH,
      { method: "POST", headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" }, body: "{}" },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "insufficient_role" });
  });

  it("allows same-repo owner sessions to plan dry-run drafts", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 201, "repo-owner", "owned-repo");
    const { token } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 201 });
    const response = await app.request(
      OWNED_REPO_PATH,
      {
        method: "POST",
        headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ goal: "improve sync reliability", dryRun: true, limit: 1 }),
      },
      env,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      repoFullName: "repo-owner/owned-repo",
      dryRun: true,
      createRequested: false,
      drafts: expect.any(Array),
    });
  });

  it("requires live GitHub write permission before session issue creation", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 201, "repo-owner", "owned-repo");
    await upsertPullRequestFromGitHub(env, "repo-owner/owned-repo", {
      number: 5,
      title: "cached collaborator scope",
      state: "open",
      user: { login: "reader" },
      author_association: "COLLABORATOR",
      head: { sha: "a1", ref: "f" },
      base: { ref: "main" },
      labels: [],
    });
    mockedPermission.mockResolvedValue("read");
    const { token } = await createSessionForGitHubUser(env, { login: "reader", id: 777 });

    const response = await app.request(
      OWNED_REPO_PATH,
      {
        method: "POST",
        headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ goal: "improve sync reliability", dryRun: false, create: true, limit: 1 }),
      },
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "insufficient_repo_permission" });
    expect(mockedPermission).toHaveBeenCalledWith(env, 201, "repo-owner/owned-repo", "reader");
  });

  it("rejects cross-repo owner sessions with forbidden_repo", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRegisteredInstalledRepo(env, 201, "repo-owner", "owned-repo");
    await seedRegisteredInstalledRepo(env, 202, "other-owner", "other-repo");
    const { token } = await createSessionForGitHubUser(env, { login: "other-owner", id: 202 });
    const response = await app.request(
      OWNED_REPO_PATH,
      {
        method: "POST",
        headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" },
        body: JSON.stringify({ goal: "improve sync reliability", dryRun: true, limit: 1 }),
      },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "forbidden_repo" });
  });

  it("rejects malformed JSON with 400", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      PLAN_PATH,
      { method: "POST", headers: { ...apiHeaders(env), "content-type": "application/json" }, body: "not-json" },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_json" });
  });

  it("rejects explicit create without dryRun false", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      PLAN_PATH,
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ goal: "improve reliability", create: true }) },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "explicit_create_requires_dry_run_false" });
  });

  it("rejects a request missing the required goal", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(
      PLAN_PATH,
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ dryRun: true, limit: 1 }) },
      env,
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_issue_plan_draft_request" });
  });

  it("returns dry-run drafts for authorized static-token callers, forwarding the goal", async () => {
    const app = createApp();
    const env = createTestEnv({ ...AI_ENABLED, AI: planningAi() });
    const response = await app.request(
      PLAN_PATH,
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ goal: "improve sync reliability", dryRun: true, limit: 2 }) },
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { repoFullName: string; status: string; dryRun: boolean; createRequested: boolean; drafts: Array<{ title: string }> };
    expect(body).toMatchObject({ repoFullName: "JSONbored/loopover", status: "ok", dryRun: true, createRequested: false });
    expect(body.drafts[0]?.title).toBe("Add retry to the sync job");
  });
});
