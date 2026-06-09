import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import * as repositories from "../../src/db/repositories";
import { upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const VALID_SETTINGS = {
  commentMode: "detected_contributors_only",
  publicAudienceMode: "oss_maintainer",
  publicSignalLevel: "standard",
  checkRunMode: "off",
  checkRunDetailLevel: "standard",
  gateCheckMode: "off",
  linkedIssueGateMode: "advisory",
  duplicatePrGateMode: "advisory",
  qualityGateMode: "advisory",
  autoLabelEnabled: true,
  gittensorLabel: "gittensor",
  createMissingLabel: true,
  publicSurface: "comment_and_label",
  includeMaintainerAuthors: false,
  requireLinkedIssue: false,
  backfillEnabled: true,
  privateTrustEnabled: true,
};

function apiHeaders(env: Env): Record<string, string> {
  return { authorization: `Bearer ${env.GITTENSORY_API_TOKEN}`, "content-type": "application/json" };
}

async function setupMaintainerFixture(env: Env, maintainerLogin: string, repoFullName: string) {
  const slashIdx = repoFullName.indexOf("/");
  const owner = repoFullName.slice(0, slashIdx);
  const name = repoFullName.slice(slashIdx + 1);
  await upsertInstallation(env, {
    installation: {
      id: 55,
      account: { login: owner, id: 10, type: "User" },
      repository_selection: "selected",
      permissions: { metadata: "read", pull_requests: "read", issues: "write" },
      events: ["pull_request"],
    },
  });
  await upsertRepositoryFromGitHub(env, { name, full_name: repoFullName, private: false, owner: { login: owner }, default_branch: "main" }, 55);
  await upsertPullRequestFromGitHub(env, repoFullName, { number: 1, title: "Fix bug", state: "open", user: { login: maintainerLogin }, body: null, labels: [], draft: false, author_association: "MEMBER" });
}

describe("maintainer settings update authorization", () => {
  it("allows an operator (static API token) to update repo settings and records an audit event", async () => {
    const app = createApp();
    const env = createTestEnv();

    const response = await app.request(
      "/v1/app/repos/owner/project/settings",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify(VALID_SETTINGS) },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.publicSurface).toBe("comment_and_label");
    expect(body.gittensorLabel).toBe("gittensor");

    const auditRow = (await env.DB.prepare("SELECT event_type, actor, target_key, outcome FROM audit_events WHERE event_type = ?")
      .bind("settings.updated")
      .first<{ event_type: string; actor: string | null; target_key: string | null; outcome: string }>());
    expect(auditRow).toMatchObject({ event_type: "settings.updated", target_key: "owner/project", outcome: "success" });
  });

  it("allows a maintainer session with PR-association evidence to update their own repo settings", async () => {
    const app = createApp();
    const env = createTestEnv();
    await setupMaintainerFixture(env, "alice", "owner/project");
    const { token } = await createSessionForGitHubUser(env, { login: "alice", id: 42 });
    const sessionHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const response = await app.request(
      "/v1/app/repos/owner/project/settings",
      { method: "POST", headers: sessionHeaders, body: JSON.stringify({ ...VALID_SETTINGS, publicSurface: "comment_only" }) },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.publicSurface).toBe("comment_only");
  });

  it("rejects a non-maintainer session with insufficient_role", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { token } = await createSessionForGitHubUser(env, { login: "outsider", id: 99 });
    const sessionHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const response = await app.request(
      "/v1/app/repos/owner/project/settings",
      { method: "POST", headers: sessionHeaders, body: JSON.stringify(VALID_SETTINGS) },
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "insufficient_role" });
  });

  it("rejects a maintainer session that tries to update a repo outside their scope", async () => {
    const app = createApp();
    const env = createTestEnv();
    await setupMaintainerFixture(env, "alice", "alice-org/alice-repo");
    const { token } = await createSessionForGitHubUser(env, { login: "alice", id: 42 });
    const sessionHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const response = await app.request(
      "/v1/app/repos/victim-org/secret-repo/settings",
      { method: "POST", headers: sessionHeaders, body: JSON.stringify(VALID_SETTINGS) },
      env,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "forbidden_repo" });
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = createApp();
    const env = createTestEnv();

    const response = await app.request(
      "/v1/app/repos/owner/project/settings",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(VALID_SETTINGS) },
      env,
    );

    expect(response.status).toBe(401);
  });

  it("rejects invalid settings body with 400", async () => {
    const app = createApp();
    const env = createTestEnv();

    const response = await app.request(
      "/v1/app/repos/owner/project/settings",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ publicSurface: "not_a_valid_enum" }) },
      env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_repository_settings" });
  });

  it("response never contains private scoring or wallet language", async () => {
    const app = createApp();
    const env = createTestEnv();

    const response = await app.request(
      "/v1/app/repos/owner/project/settings",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify(VALID_SETTINGS) },
      env,
    );

    expect(response.status).toBe(200);
    const raw = JSON.stringify(await response.json());
    expect(raw).not.toMatch(/wallet|hotkey|raw trust|reward estimate|payout|farming|private reviewability|scoreability|public score estimate/i);
  });

  it("returns 400 for malformed JSON request body instead of silently writing defaults", async () => {
    const app = createApp();
    const env = createTestEnv();

    const response = await app.request(
      "/v1/app/repos/owner/project/settings",
      { method: "POST", headers: { ...apiHeaders(env), "content-type": "application/json" }, body: "{ not valid json" },
      env,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_request_body" });
  });

  it("propagates audit write failures instead of silently swallowing them", async () => {
    const app = createApp();
    const env = createTestEnv();
    vi.spyOn(repositories, "recordAuditEvent").mockRejectedValueOnce(new Error("db write failed"));

    const response = await app.request(
      "/v1/app/repos/owner/project/settings",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify(VALID_SETTINGS) },
      env,
    );

    expect(response.status).toBe(500);
    vi.restoreAllMocks();
  });

  it("persists all gate and policy settings without silently resetting to defaults", async () => {
    const app = createApp();
    const env = createTestEnv();

    const response = await app.request(
      "/v1/app/repos/owner/project/settings",
      {
        method: "POST",
        headers: apiHeaders(env),
        body: JSON.stringify({
          ...VALID_SETTINGS,
          publicAudienceMode: "gittensor_only",
          gateCheckMode: "enabled",
          linkedIssueGateMode: "block",
          duplicatePrGateMode: "block",
          qualityGateMode: "block",
          qualityGateMinScore: 75,
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.publicAudienceMode).toBe("gittensor_only");
    expect(body.gateCheckMode).toBe("enabled");
    expect(body.linkedIssueGateMode).toBe("block");
    expect(body.duplicatePrGateMode).toBe("block");
    expect(body.qualityGateMode).toBe("block");
    expect(body.qualityGateMinScore).toBe(75);
  });

  it("allows an owner-installation session to update their own repo settings", async () => {
    const app = createApp();
    const env = createTestEnv();
    await upsertInstallation(env, {
      installation: {
        id: 77,
        account: { login: "repo-owner", id: 20, type: "User" },
        repository_selection: "selected",
        permissions: { metadata: "read", pull_requests: "read", issues: "write" },
        events: ["pull_request"],
      },
    });
    await upsertRepositoryFromGitHub(env, { name: "owned-repo", full_name: "repo-owner/owned-repo", private: false, owner: { login: "repo-owner" }, default_branch: "main" }, 77);
    const { token } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 20 });
    const sessionHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const response = await app.request(
      "/v1/app/repos/repo-owner/owned-repo/settings",
      { method: "POST", headers: sessionHeaders, body: JSON.stringify({ ...VALID_SETTINGS, requireLinkedIssue: true }) },
      env,
    );

    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body.requireLinkedIssue).toBe(true);
  });
});
