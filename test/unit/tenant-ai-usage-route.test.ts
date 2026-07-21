import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { recordAiUsageEvent, upsertInstallation, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #7660: GET /v1/app/tenant-ai-usage -- the tenant-facing counterpart to the operator-only
// listAiCostByTenantSince breakdown, scoped the SAME WAY /v1/app/maintainer-dashboard scopes its data
// (src/api/routes.ts), and exposing normalized compute-units rather than raw costUsd.

function apiHeaders(env: Env): Record<string, string> {
  return { authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" };
}

async function seedOwnedInstallation(env: Env, owner: string, installationId: number, repoName = "repo"): Promise<void> {
  await upsertInstallation(env, {
    installation: {
      id: installationId,
      account: { login: owner, id: installationId, type: "User" },
      repository_selection: "selected",
      permissions: { metadata: "read" },
      events: ["repository"],
    },
  });
  await upsertRepositoryFromGitHub(env, { name: repoName, full_name: `${owner}/${repoName}`, private: false, owner: { login: owner } }, installationId);
}

describe("GET /v1/app/tenant-ai-usage (#7660)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-21T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects an unauthenticated request", async () => {
    const app = createApp();
    const env = createTestEnv();
    const res = await app.request("/v1/app/tenant-ai-usage", {}, env);
    expect(res.status).toBe(401);
  });

  it("rejects a session with no maintainer/owner/operator role", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "someone-else" });
    const { token } = await createSessionForGitHubUser(env, { login: "nobody", id: 1 });
    const res = await app.request("/v1/app/tenant-ai-usage", { headers: { cookie: `loopover_session=${token}` } }, env);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "insufficient_role" });
  });

  it("scopes an owner session to their own installation and excludes another tenant's spend", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedInstallation(env, "tenant-owner", 101);
    await seedOwnedInstallation(env, "other-tenant", 202);
    // In-window spend for the requesting tenant's own installation.
    await recordAiUsageEvent(env, { feature: "ai_review", model: "claude-sonnet-5", status: "ok", estimatedNeurons: 10, costUsd: 3.0, installationId: "101" });
    // A different tenant's spend must never leak into this session's total.
    await recordAiUsageEvent(env, { feature: "ai_review", model: "claude-sonnet-5", status: "ok", estimatedNeurons: 10, costUsd: 500.0, installationId: "202" });

    const { token } = await createSessionForGitHubUser(env, { login: "tenant-owner", id: 101 });
    const res = await app.request("/v1/app/tenant-ai-usage", { headers: { cookie: `loopover_session=${token}` } }, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { generatedAt: string; windowDays: number; since: string; usage: { computeUnits: number } };
    expect(body.usage.computeUnits).toBe(300); // $3.00 -> 300 compute-units ($0.01/unit)
    expect(body.windowDays).toEqual(expect.any(Number));
    expect(body.since).toEqual(expect.any(String));
    expect(JSON.stringify(body)).not.toContain("other-tenant");
  });

  it("reports 0 compute-units for a scoped tenant with no AI usage yet", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedInstallation(env, "quiet-owner", 303);

    const { token } = await createSessionForGitHubUser(env, { login: "quiet-owner", id: 303 });
    const res = await app.request("/v1/app/tenant-ai-usage", { headers: { cookie: `loopover_session=${token}` } }, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ usage: { computeUnits: 0 } });
  });

  it("respects a valid ?days= window, excluding spend older than it", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedInstallation(env, "windowed-owner", 404);
    await recordAiUsageEvent(env, { feature: "ai_review", model: "claude-sonnet-5", status: "ok", estimatedNeurons: 10, costUsd: 1.0, installationId: "404" });
    await env.DB.prepare("UPDATE ai_usage_events SET created_at = ? WHERE installation_id = '404'").bind("2026-06-01T00:00:00.000Z").run();

    const { token } = await createSessionForGitHubUser(env, { login: "windowed-owner", id: 404 });
    const res = await app.request("/v1/app/tenant-ai-usage?days=7", { headers: { cookie: `loopover_session=${token}` } }, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ windowDays: 7, usage: { computeUnits: 0 } });
  });

  it("gives an operator (unscoped) session the combined total across every tenant", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "operator-user" });
    await seedOwnedInstallation(env, "tenant-a", 501);
    await seedOwnedInstallation(env, "tenant-b", 502);
    await recordAiUsageEvent(env, { feature: "ai_review", model: "claude-sonnet-5", status: "ok", estimatedNeurons: 10, costUsd: 1.0, installationId: "501" });
    await recordAiUsageEvent(env, { feature: "ai_review", model: "claude-sonnet-5", status: "ok", estimatedNeurons: 10, costUsd: 2.0, installationId: "502" });

    const { token } = await createSessionForGitHubUser(env, { login: "operator-user", id: 999 });
    const res = await app.request("/v1/app/tenant-ai-usage", { headers: { cookie: `loopover_session=${token}` } }, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ usage: { computeUnits: 300 } }); // (1.0 + 2.0) USD combined
  });

  it("gives static (service-credential) callers the same unscoped, full-fleet view", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
    await seedOwnedInstallation(env, "tenant-c", 601);
    await recordAiUsageEvent(env, { feature: "ai_review", model: "claude-sonnet-5", status: "ok", estimatedNeurons: 10, costUsd: 4.0, installationId: "601" });

    const res = await app.request("/v1/app/tenant-ai-usage", { headers: apiHeaders(env) }, env);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ usage: { computeUnits: 400 } });
  });
});
