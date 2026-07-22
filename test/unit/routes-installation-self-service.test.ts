import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { upsertInstallation, upsertInstallationHealth } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #7661: tenant self-service for installation health/repair. A hosted tenant (a non-operator browser session)
// may see and repair ONLY their own installation; an operator or a server-to-server token keeps the unscoped
// fleet view. Mirrors the maintainer-dashboard's identity → role-gate → loadControlPanelAccessScope scoping.

// A server-to-server token (kind "api") -> scope null -> unscoped operator-equivalent view, exactly like today.
function apiHeaders(env: Env): Record<string, string> {
  return { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" };
}

function sessionCookie(token: string): Record<string, string> {
  return { cookie: `loopover_session=${token}`, "content-type": "application/json" };
}

async function seedInstallation(env: Env, installationId: number, login: string): Promise<void> {
  await upsertInstallation(env, {
    installation: {
      id: installationId,
      account: { login, id: installationId, type: "User" },
      repository_selection: "selected",
      permissions: { metadata: "read", contents: "read", pull_requests: "write", issues: "write" },
      events: ["pull_request", "issues", "issue_comment", "repository"],
    },
  });
  await upsertInstallationHealth(env, {
    installationId,
    accountLogin: login,
    installedReposCount: 1,
    registeredInstalledCount: 1,
    status: "healthy",
    missingPermissions: [],
    missingEvents: [],
    permissions: { metadata: "read" },
    events: ["pull_request"],
    checkedAt: "2026-07-20T00:00:00.000Z",
    authMode: "local",
  });
}

// alice (installation 111) and bob (installation 222) are two separate hosted tenants.
async function seedTwoTenants(env: Env): Promise<{ aliceToken: string; bobToken: string }> {
  await seedInstallation(env, 111, "alice");
  await seedInstallation(env, 222, "bob");
  const alice = await createSessionForGitHubUser(env, { login: "alice", id: 501 });
  const bob = await createSessionForGitHubUser(env, { login: "bob", id: 502 });
  return { aliceToken: alice.token, bobToken: bob.token };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("installation self-service scoping (#7661)", () => {
  it("an unauthenticated request is rejected (middleware)", async () => {
    const app = createApp();
    const env = createTestEnv();
    expect((await app.request("/v1/installations", {}, env)).status).toBe(401);
  });

  it("a session with no installation/role is denied on every installation route with insufficient_role", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { token } = await createSessionForGitHubUser(env, { login: "nobody", id: 999 });
    const cookie = sessionCookie(token);
    const requests = [
      app.request("/v1/installations", { headers: cookie }, env),
      app.request("/v1/installations/111/health", { headers: cookie }, env),
      app.request("/v1/installations/111/repair", { headers: cookie }, env),
      app.request("/v1/installations/111/repair/refresh", { method: "POST", headers: cookie }, env),
    ];
    for (const request of requests) {
      const res = await request;
      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toMatchObject({ error: "insufficient_role" });
    }
  });

  it("an operator/service token sees every installation and health record (unscoped)", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedTwoTenants(env);
    const res = await app.request("/v1/installations", { headers: apiHeaders(env) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { installations: Array<{ id: number }>; health: Array<{ installationId: number }> };
    expect(body.installations.map((i) => i.id).sort()).toEqual([111, 222]);
    expect(body.health.map((h) => h.installationId).sort()).toEqual([111, 222]);
  });

  it("a tenant's list is scoped to only their own installation and health", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { aliceToken } = await seedTwoTenants(env);
    const res = await app.request("/v1/installations", { headers: sessionCookie(aliceToken) }, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { installations: Array<{ id: number }>; health: Array<{ installationId: number }> };
    expect(body.installations.map((i) => i.id)).toEqual([111]);
    expect(body.health.map((h) => h.installationId)).toEqual([111]);
  });

  it("a tenant can read their own installation health, but another tenant's returns not-found", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { aliceToken } = await seedTwoTenants(env);

    const own = await app.request("/v1/installations/111/health", { headers: sessionCookie(aliceToken) }, env);
    expect(own.status).toBe(200);
    await expect(own.json()).resolves.toMatchObject({ installationId: 111, accountLogin: "alice" });

    const other = await app.request("/v1/installations/222/health", { headers: sessionCookie(aliceToken) }, env);
    expect(other.status).toBe(404); // same not-found shape as a missing id — cross-tenant existence never leaks
    await expect(other.json()).resolves.toMatchObject({ error: "installation_health_not_found" });
  });

  it("a tenant can read their own repair diagnostics, but another tenant's returns not-found", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { aliceToken } = await seedTwoTenants(env);

    const own = await app.request("/v1/installations/111/repair", { headers: sessionCookie(aliceToken) }, env);
    expect(own.status).toBe(200);

    const other = await app.request("/v1/installations/222/repair", { headers: sessionCookie(aliceToken) }, env);
    expect(other.status).toBe(404);
    await expect(other.json()).resolves.toMatchObject({ error: "installation_health_not_found" });
  });

  it("a tenant cannot trigger a refresh on another tenant's installation (denied before any mutation)", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { aliceToken } = await seedTwoTenants(env);
    const fetchSpy = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await app.request("/v1/installations/222/repair/refresh", { method: "POST", headers: sessionCookie(aliceToken) }, env);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "installation_not_found" });
    expect(fetchSpy).not.toHaveBeenCalled(); // scope-checked BEFORE the mutation, so no refresh work happens
  });

  it("a tenant can trigger a refresh on their own installation", async () => {
    const app = createApp();
    const env = createTestEnv();
    const { aliceToken } = await seedTwoTenants(env);
    // The refresh recomputes health via GitHub; a failed fetch degrades to an error summary (not a throw), so
    // the scoped owner still gets a 200 refreshed result — this test proves ownership passes the scope gate.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 500 })));

    const res = await app.request("/v1/installations/111/repair/refresh", { method: "POST", headers: sessionCookie(aliceToken) }, env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ refreshed: true });
  });

  it("an operator can refresh any installation (unscoped), and an invalid id is a 400", async () => {
    const app = createApp();
    const env = createTestEnv();
    await seedTwoTenants(env);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 500 })));

    const refreshed = await app.request("/v1/installations/222/repair/refresh", { method: "POST", headers: apiHeaders(env) }, env);
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({ refreshed: true });

    const badId = await app.request("/v1/installations/not-a-number/health", { headers: apiHeaders(env) }, env);
    expect(badId.status).toBe(400);
  });
});
