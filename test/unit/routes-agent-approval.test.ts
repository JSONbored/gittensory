import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/github/pr-actions", () => ({
  createPullRequestReview: vi.fn(async () => ({ id: 1 })),
  mergePullRequest: vi.fn(async () => ({ merged: true, sha: "merged-sha" })),
  closePullRequest: vi.fn(async () => ({ state: "closed" })),
  createIssueComment: vi.fn(async () => ({ id: 2 })),
}));
vi.mock("../../src/github/labels", () => ({
  ensurePullRequestLabel: vi.fn(async () => ({ applied: true, created: false })),
}));

import { mergePullRequest } from "../../src/github/pr-actions";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { createApp } from "../../src/api/routes";
import { createPendingAgentActionIfAbsent, getPendingAgentAction, upsertInstallation, upsertPullRequestFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const app = createApp();
const headers = (env: Env) => ({ authorization: `Bearer ${env.GITTENSORY_API_TOKEN}`, "content-type": "application/json" });

async function seedPending(env: Env) {
  await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto_with_approval" } });
  await upsertInstallation(env, {
    installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
    repositories: [{ name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }],
  });
  await upsertPullRequestFromGitHub(env, "owner/repo", { number: 7, title: "PR", state: "open", user: { login: "contributor" }, head: { sha: "h7" }, labels: [], body: "x" });
  const { action } = await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: { mergeMethod: "squash" }, reason: "clean" });
  return action;
}

describe("agent approval-queue routes (#779)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists a repo's pending actions (maintainer-scoped)", async () => {
    const env = createTestEnv();
    await seedPending(env);
    const res = await app.request("/v1/repos/owner/repo/agent/pending-actions", { headers: headers(env) }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ repoFullName: "owner/repo", pendingActions: [{ actionClass: "merge", status: "pending" }] });
  });

  it("requires authentication", async () => {
    const env = createTestEnv();
    const res = await app.request("/v1/repos/owner/repo/agent/pending-actions", {}, env);
    expect([401, 403]).toContain(res.status);
  });

  it("accept executes the staged action and marks it accepted", async () => {
    const env = createTestEnv();
    const action = await seedPending(env);
    const res = await app.request(`/v1/repos/owner/repo/agent/pending-actions/${action.id}/accept`, { method: "POST", headers: headers(env) }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "accepted", executionOutcome: "completed" });
    expect(mergePullRequest).toHaveBeenCalled();
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("accepted");
  });

  it("reject cancels the staged action without executing", async () => {
    const env = createTestEnv();
    const action = await seedPending(env);
    const res = await app.request(`/v1/repos/owner/repo/agent/pending-actions/${action.id}/reject`, { method: "POST", headers: headers(env) }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "rejected" });
    expect(mergePullRequest).not.toHaveBeenCalled();
    expect((await getPendingAgentAction(env, action.id))?.status).toBe("rejected");
  });

  it("rejects an invalid decision verb with 400", async () => {
    const env = createTestEnv();
    const action = await seedPending(env);
    const res = await app.request(`/v1/repos/owner/repo/agent/pending-actions/${action.id}/maybe`, { method: "POST", headers: headers(env) }, env);
    expect(res.status).toBe(400);
  });

  it("404s an unknown id or another repo's action (no cross-repo decisions)", async () => {
    const env = createTestEnv();
    const action = await seedPending(env);
    const unknown = await app.request("/v1/repos/owner/repo/agent/pending-actions/nope/accept", { method: "POST", headers: headers(env) }, env);
    expect(unknown.status).toBe(404);
    // the action belongs to owner/repo; decided via a different repo path → 404
    const crossRepo = await app.request(`/v1/repos/other/repo/agent/pending-actions/${action.id}/accept`, { method: "POST", headers: headers(env) }, env);
    expect(crossRepo.status).toBe(404);
  });

  it("a non-operator session is forbidden from the queue", async () => {
    const env = createTestEnv();
    await seedPending(env);
    const { token } = await createSessionForGitHubUser(env, { login: "rando", id: 555 });
    const list = await app.request("/v1/repos/owner/repo/agent/pending-actions", { headers: { authorization: `Bearer ${token}` } }, env);
    expect([401, 403]).toContain(list.status);
    const decide = await app.request("/v1/repos/owner/repo/agent/pending-actions/x/accept", { method: "POST", headers: { authorization: `Bearer ${token}` } }, env);
    expect([401, 403]).toContain(decide.status);
  });

  it("an operator session decides under its own identity", async () => {
    const env = createTestEnv();
    const action = await seedPending(env);
    const { token } = await createSessionForGitHubUser(env, { login: "jsonbored", id: 1 });
    const res = await app.request(`/v1/repos/owner/repo/agent/pending-actions/${action.id}/reject`, { method: "POST", headers: { authorization: `Bearer ${token}` } }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "rejected", action: { decidedBy: "jsonbored" } });
  });

  it("a second decision returns 409 already_decided", async () => {
    const env = createTestEnv();
    const action = await seedPending(env);
    await app.request(`/v1/repos/owner/repo/agent/pending-actions/${action.id}/reject`, { method: "POST", headers: headers(env) }, env);
    const again = await app.request(`/v1/repos/owner/repo/agent/pending-actions/${action.id}/accept`, { method: "POST", headers: headers(env) }, env);
    expect(again.status).toBe(409);
  });
});
