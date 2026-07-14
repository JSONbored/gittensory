import { beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/api/routes";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { upsertInstallation, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #5672: reporting path for an already-merged rented-loop PR later found harmful. Two entry points --
// a repo-maintainer (customer) route and an internal-operator route -- both persist through the same
// recordPostMergeIncidentReport helper into audit_events, keyed to the PR's `repo#number` targetKey.

const app = createApp();
const apiHeaders = (env: Env) => ({ authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`, "content-type": "application/json" });

async function seedRepoWithPulls(env: Env) {
  await upsertInstallation(env, {
    installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", contents: "write", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
  });
  await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
  await upsertPullRequestFromGitHub(env, "owner/repo", {
    number: 7,
    title: "Merged PR",
    state: "closed",
    merged_at: "2026-06-18T10:00:00.000Z",
    user: { login: "a-miner" },
    head: { sha: "deadbeef" },
    labels: [],
    body: "x",
  });
  await upsertPullRequestFromGitHub(env, "owner/repo", {
    number: 8,
    title: "Open PR",
    state: "open",
    user: { login: "a-miner" },
    head: { sha: "open-sha" },
    labels: [],
    body: "x",
  });
}

async function auditRows(env: Env): Promise<Array<{ actor: string; outcome: string; target_key: string; detail: string; metadata_json: string }>> {
  const result = (await env.DB.prepare(
    "select actor, outcome, target_key, detail, metadata_json from audit_events where event_type = 'agent.post_merge_incident_reported' order by created_at desc",
  ).all()) as { results: Array<{ actor: string; outcome: string; target_key: string; detail: string; metadata_json: string }> };
  return result.results;
}

describe("post-merge incident report routes (#5672)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("customer-facing route: POST /v1/repos/:owner/:repo/pulls/:number/incident-reports", () => {
    it("records a complete audit-trail entry for a merged PR (static token, mergedSha included)", async () => {
      const env = createTestEnv();
      await seedRepoWithPulls(env);
      const res = await app.request(
        "/v1/repos/owner/repo/pulls/7/incident-reports",
        { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ description: "broke prod config", severity: "high", mergedSha: "deadbeef" }) },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; repoFullName: string; pullNumber: number; id: string; createdAt: string };
      expect(body).toMatchObject({ ok: true, repoFullName: "owner/repo", pullNumber: 7 });
      expect(typeof body.id).toBe("string");
      expect(typeof body.createdAt).toBe("string");

      const rows = await auditRows(env);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor: "maintainer", outcome: "completed", target_key: "owner/repo#7", detail: "broke prod config" });
      expect(JSON.parse(rows[0]!.metadata_json)).toMatchObject({ severity: "high", mergedSha: "deadbeef", reporterKind: "customer" });
    });

    it("records the reporting maintainer's own login as actor for a session caller, and omits mergedSha as null", async () => {
      const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
      await seedRepoWithPulls(env);
      const { token } = await createSessionForGitHubUser(env, { login: "owner", id: 1 });
      const res = await app.request(
        "/v1/repos/owner/repo/pulls/7/incident-reports",
        { method: "POST", headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ description: "silent data loss", severity: "critical" }) },
        env,
      );
      expect(res.status).toBe(200);
      const rows = await auditRows(env);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor: "owner" });
      expect(JSON.parse(rows[0]!.metadata_json)).toMatchObject({ severity: "critical", mergedSha: null, reporterKind: "customer" });
    });

    it("404s an unknown pull request", async () => {
      const env = createTestEnv();
      await seedRepoWithPulls(env);
      const res = await app.request(
        "/v1/repos/owner/repo/pulls/999/incident-reports",
        { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ description: "x", severity: "low" }) },
        env,
      );
      expect(res.status).toBe(404);
      await expect(res.json()).resolves.toMatchObject({ error: "pull_request_not_found" });
      expect(await auditRows(env)).toHaveLength(0);
    });

    it("409s a pull request that has not been merged", async () => {
      const env = createTestEnv();
      await seedRepoWithPulls(env);
      const res = await app.request(
        "/v1/repos/owner/repo/pulls/8/incident-reports",
        { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ description: "x", severity: "low" }) },
        env,
      );
      expect(res.status).toBe(409);
      await expect(res.json()).resolves.toMatchObject({ error: "pull_request_not_merged" });
      expect(await auditRows(env)).toHaveLength(0);
    });

    it("rejects a non-positive-integer pull number with 400", async () => {
      const env = createTestEnv();
      await seedRepoWithPulls(env);
      for (const bad of ["0", "-1", "abc", "1.5"]) {
        const res = await app.request(`/v1/repos/owner/repo/pulls/${bad}/incident-reports`, { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ description: "x", severity: "low" }) }, env);
        expect(res.status, `number=${bad}`).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: "invalid_pull_number" });
      }
    });

    it("rejects a schema-invalid body (missing description, bad severity, unknown field) with 400", async () => {
      const env = createTestEnv();
      await seedRepoWithPulls(env);
      for (const bad of [{ severity: "high" }, { description: "x", severity: "catastrophic" }, { description: "x", severity: "high", extra: true }]) {
        const res = await app.request("/v1/repos/owner/repo/pulls/7/incident-reports", { method: "POST", headers: apiHeaders(env), body: JSON.stringify(bad) }, env);
        expect(res.status, JSON.stringify(bad)).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: "invalid_incident_report" });
      }
      expect(await auditRows(env)).toHaveLength(0);
    });

    it("rejects a body that isn't valid JSON at all", async () => {
      const env = createTestEnv();
      await seedRepoWithPulls(env);
      const res = await app.request("/v1/repos/owner/repo/pulls/7/incident-reports", { method: "POST", headers: apiHeaders(env), body: "{" }, env);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "invalid_incident_report" });
    });

    it("requires authentication and forbids a non-maintainer session", async () => {
      const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "" });
      await seedRepoWithPulls(env);
      const noauth = await app.request("/v1/repos/owner/repo/pulls/7/incident-reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: "x", severity: "low" }) }, env);
      expect([401, 403]).toContain(noauth.status);

      const { token } = await createSessionForGitHubUser(env, { login: "contributor", id: 999 });
      const forbidden = await app.request(
        "/v1/repos/owner/repo/pulls/7/incident-reports",
        { method: "POST", headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ description: "x", severity: "low" }) },
        env,
      );
      expect([401, 403]).toContain(forbidden.status);
      expect(await auditRows(env)).toHaveLength(0);
    });
  });

  describe("internal-operator route: POST /v1/app/incident-reports", () => {
    it("records a complete audit-trail entry, actor from identity, mergedSha absent as null", async () => {
      const env = createTestEnv();
      await seedRepoWithPulls(env);
      const res = await app.request(
        "/v1/app/incident-reports",
        { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ repoFullName: "owner/repo", pullNumber: 7, description: "customer escalation", severity: "medium" }) },
        env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; repoFullName: string; pullNumber: number; id: string; createdAt: string };
      expect(body).toMatchObject({ ok: true, repoFullName: "owner/repo", pullNumber: 7 });

      const rows = await auditRows(env);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actor: "api", outcome: "completed", target_key: "owner/repo#7", detail: "customer escalation" });
      expect(JSON.parse(rows[0]!.metadata_json)).toMatchObject({ severity: "medium", mergedSha: null, reporterKind: "operator" });
    });

    it("includes mergedSha when supplied", async () => {
      const env = createTestEnv();
      await seedRepoWithPulls(env);
      const res = await app.request(
        "/v1/app/incident-reports",
        { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ repoFullName: "owner/repo", pullNumber: 7, description: "x", severity: "low", mergedSha: "deadbeef" }) },
        env,
      );
      expect(res.status).toBe(200);
      const rows = await auditRows(env);
      expect(JSON.parse(rows[0]!.metadata_json)).toMatchObject({ mergedSha: "deadbeef" });
    });

    it("404s an unknown pull request and 409s an unmerged one", async () => {
      const env = createTestEnv();
      await seedRepoWithPulls(env);
      const notFound = await app.request(
        "/v1/app/incident-reports",
        { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ repoFullName: "owner/repo", pullNumber: 999, description: "x", severity: "low" }) },
        env,
      );
      expect(notFound.status).toBe(404);
      await expect(notFound.json()).resolves.toMatchObject({ error: "pull_request_not_found" });

      const notMerged = await app.request(
        "/v1/app/incident-reports",
        { method: "POST", headers: apiHeaders(env), body: JSON.stringify({ repoFullName: "owner/repo", pullNumber: 8, description: "x", severity: "low" }) },
        env,
      );
      expect(notMerged.status).toBe(409);
      await expect(notMerged.json()).resolves.toMatchObject({ error: "pull_request_not_merged" });
      expect(await auditRows(env)).toHaveLength(0);
    });

    it("rejects a schema-invalid body with 400", async () => {
      const env = createTestEnv();
      await seedRepoWithPulls(env);
      for (const bad of [{ pullNumber: 7, description: "x", severity: "low" }, { repoFullName: "owner/repo", pullNumber: 0, description: "x", severity: "low" }, { repoFullName: "owner/repo", pullNumber: 7, description: "", severity: "low" }]) {
        const res = await app.request("/v1/app/incident-reports", { method: "POST", headers: apiHeaders(env), body: JSON.stringify(bad) }, env);
        expect(res.status, JSON.stringify(bad)).toBe(400);
        await expect(res.json()).resolves.toMatchObject({ error: "invalid_incident_report" });
      }
    });

    it("rejects a body that isn't valid JSON at all", async () => {
      const env = createTestEnv();
      const res = await app.request("/v1/app/incident-reports", { method: "POST", headers: apiHeaders(env), body: "{" }, env);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "invalid_incident_report" });
    });

    it("is unauthorized with no identity and forbidden for a non-operator session", async () => {
      const env = createTestEnv();
      await seedRepoWithPulls(env);
      const noauth = await app.request("/v1/app/incident-reports", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repoFullName: "owner/repo", pullNumber: 7, description: "x", severity: "low" }) }, env);
      expect(noauth.status).toBe(401);

      const { token } = await createSessionForGitHubUser(env, { login: "not-an-operator", id: 501 });
      const forbidden = await app.request(
        "/v1/app/incident-reports",
        { method: "POST", headers: { cookie: `loopover_session=${token}`, "content-type": "application/json" }, body: JSON.stringify({ repoFullName: "owner/repo", pullNumber: 7, description: "x", severity: "low" }) },
        env,
      );
      expect(forbidden.status).toBe(403);
      expect(await auditRows(env)).toHaveLength(0);
    });

    it("rejects the shared MCP token without recording anything", async () => {
      const env = createTestEnv();
      await seedRepoWithPulls(env);
      const headers = { authorization: `Bearer ${env.LOOPOVER_MCP_TOKEN}`, "content-type": "application/json" };
      const res = await app.request("/v1/app/incident-reports", { method: "POST", headers, body: JSON.stringify({ repoFullName: "owner/repo", pullNumber: 7, description: "x", severity: "low" }) }, env);
      expect(res.status).toBe(403);
      expect(await auditRows(env)).toHaveLength(0);
    });
  });
});
