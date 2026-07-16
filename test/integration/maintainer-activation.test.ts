import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { getRepositorySettings, upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { getRepositoryCollaboratorPermission } from "../../src/github/app";
import { createTestEnv } from "../helpers/d1";

vi.mock("../../src/github/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/github/app")>()),
  getRepositoryCollaboratorPermission: vi.fn(),
}));
const mockedPermission = vi.mocked(getRepositoryCollaboratorPermission);

const FULL_NAME = "owner/repo";
const PATH_PREVIEW = "/v1/repos/owner/repo/activation-preview";
const PATH_SETTINGS = "/v1/repos/owner/repo/settings";

async function seedRepo(env: Env, owner: string, name: string, installationId: number): Promise<void> {
  await upsertInstallation(env, {
    installation: { id: installationId, account: { login: owner, id: installationId, type: "User" }, repository_selection: "selected", permissions: { metadata: "read" }, events: ["repository"] },
  });
  await upsertRepositoryFromGitHub(env, { name, full_name: `${owner}/${name}`, private: false, owner: { login: owner } }, installationId);
  await env.DB.prepare("UPDATE repositories SET is_registered = 1 WHERE full_name = ?").bind(`${owner}/${name}`).run();
}

function stubMinerFetch() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (input.toString().includes("gittensor.io")) return Response.json([]);
    return new Response("not found", { status: 404 });
  });
}

describe("maintainer activation routes", () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => mockedPermission.mockReset());
  it("lets a maintainer preview activation (reviewCheckMode is config-as-code only now, #6444)", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "operator-admin" });
    const { token } = await createSessionForGitHubUser(env, { login: "operator-admin", id: 1 });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

    const preview = await app.request(PATH_PREVIEW, { headers }, env);
    expect(preview.status).toBe(200);
    const previewBody = (await preview.json()) as { repoFullName: string; recommendedAction: string | null; currentReviewCheckMode: string; evaluatedCount: number };
    expect(previewBody).toMatchObject({ repoFullName: FULL_NAME, recommendedAction: "enable_advisory", currentReviewCheckMode: "disabled", evaluatedCount: 0 });

    // POST /activation (the one-click "enable advisory mode" action) was removed here: reviewCheckMode/
    // linkedIssueGateMode/duplicatePrGateMode/qualityGateMode are all config-as-code only now (Batch C,
    // loopover#6444) -- there was nothing left for a DB-write action to meaningfully do.
    expect((await getRepositorySettings(env, FULL_NAME)).reviewCheckMode).toBe("disabled");
  });

  it("forbids read-only repo collaborators from writing agent settings", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "owner", "repo", 201);
    await upsertPullRequestFromGitHub(env, FULL_NAME, {
      number: 8,
      title: "docs tweak",
      state: "open",
      user: { login: "reader" },
      author_association: "COLLABORATOR",
      head: { sha: "def456", ref: "docs-2" },
      base: { ref: "main" },
      labels: [],
    });
    stubMinerFetch();
    mockedPermission.mockResolvedValue("read");
    const { token } = await createSessionForGitHubUser(env, { login: "reader", id: 777 });
    const headers = { cookie: `loopover_session=${token}`, "content-type": "application/json" };

    const update = await app.request(PATH_SETTINGS, {
      method: "PUT",
      headers,
      body: JSON.stringify({ autonomy: { merge: "auto" }, autoMaintain: { requireApprovals: 0, mergeMethod: "merge" } }),
    }, env);

    expect(update.status).toBe(403);
    expect(await update.json()).toMatchObject({ error: "insufficient_repo_permission" });
    const persisted = await getRepositorySettings(env, FULL_NAME);
    expect(persisted.autonomy).not.toMatchObject({ merge: "auto" });
    expect(persisted.autoMaintain?.requireApprovals).toBe(1);
  });

  it("allows a session with GitHub write permission to update repository settings", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "owner", "repo", 201);
    stubMinerFetch();
    mockedPermission.mockResolvedValue("write");
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 201 });
    const response = await app.request(PATH_SETTINGS, {
      method: "PUT",
      headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" },
      // autoMaintain moved off the DB entirely (config-as-code, loopover#6445) -- no longer a writable key on
      // this route.
      body: JSON.stringify({ autonomy: { merge: "auto_with_approval" } }),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ autonomy: { merge: "auto_with_approval" } });
  });

  it("ignores selfAuthoredLinkedIssueGateMode on the settings PUT -- config-as-code only now (#6444)", async () => {
    // selfAuthoredLinkedIssueGateMode was removed from maintainerSettingsSchema in Batch C
    // (loopover#6444): it's config-as-code only via .loopover.yml's gate.selfAuthoredLinkedIssue block
    // now, so a dashboard save attempting to set it is silently dropped (unknown key on a non-strict
    // partial schema), not persisted, and the response reflects the hardcoded "advisory" default.
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedRepo(env, "owner", "repo", 202);
    stubMinerFetch();
    mockedPermission.mockResolvedValue("write");
    const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 202 });
    const response = await app.request(PATH_SETTINGS, {
      method: "PUT",
      headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" },
      body: JSON.stringify({ selfAuthoredLinkedIssueGateMode: "block" }),
    }, env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ selfAuthoredLinkedIssueGateMode: "advisory" });
    const persisted = await getRepositorySettings(env, FULL_NAME);
    expect(persisted.selfAuthoredLinkedIssueGateMode).toBe("advisory");
  });

  it("forbids a non-maintainer session from the activation preview", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "operator-admin" });
    const { token } = await createSessionForGitHubUser(env, { login: "random-user", id: 2 });
    const response = await app.request(PATH_PREVIEW, { headers: { authorization: `Bearer ${token}` } }, env);
    expect(response.status).toBe(403);
  });

  it("allows a server-to-server token", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request(PATH_PREVIEW, { headers: { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}` } }, env);
    expect(response.status).toBe(200);
  });
});
