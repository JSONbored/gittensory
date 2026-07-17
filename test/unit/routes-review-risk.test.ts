import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApp } from "../../src/api/routes";
import { LoopoverMcp } from "../../src/mcp/server";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { buildReviewRiskExplanation } from "../../src/signals/review-risk";
import { createTestEnv } from "../helpers/d1";

const apiHeaders = (env: Env) => ({
  authorization: `Bearer ${env.LOOPOVER_API_TOKEN}`,
  "content-type": "application/json",
});

describe("POST /v1/preflight/review-risk (#6980)", () => {
  it("rejects an invalid body with 400", async () => {
    const app = createApp();
    const env = createTestEnv();
    const response = await app.request("/v1/preflight/review-risk", { method: "POST", headers: apiHeaders(env), body: "{}" }, env);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_preflight_request" });
  });

  it("returns a review-risk explanation without contributorLogin", async () => {
    const app = createApp();
    const env = createTestEnv();
    const input = { repoFullName: "missing/repo", title: "Docs note" };
    const expected = buildReviewRiskExplanation({ input, repo: null, issues: [], pullRequests: [], bounties: [] });
    const response = await app.request(
      "/v1/preflight/review-risk",
      { method: "POST", headers: apiHeaders(env), body: JSON.stringify(input) },
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      preflight: { repoFullName: string; status: string };
      roleContext: null;
      recommendation: string;
      summary: string;
    };
    expect(body).toMatchObject({
      roleContext: null,
      summary: expected.summary,
      recommendation: expected.recommendation,
      preflight: { repoFullName: "missing/repo", status: expected.preflight.status },
    });
  });

  it("honors contributorLogin when the session matches", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "miner" });
    const { token } = await createSessionForGitHubUser(env, { login: "miner", id: 1 });
    const input = {
      repoFullName: "missing/repo",
      title: "Docs note",
      contributorLogin: "miner",
    };
    const response = await app.request(
      "/v1/preflight/review-risk",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      },
      env,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { roleContext: { login: string } | null; recommendation: string };
    expect(body.roleContext).toMatchObject({ login: "miner" });
    expect(body.recommendation).toEqual(expect.any(String));
  });

  it("forbids a session from using another login as contributorLogin", async () => {
    const app = createApp();
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "miner" });
    const { token } = await createSessionForGitHubUser(env, { login: "miner", id: 1 });
    const response = await app.request(
      "/v1/preflight/review-risk",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ repoFullName: "missing/repo", title: "Docs note", contributorLogin: "other" }),
      },
      env,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "forbidden_contributor" });
  });

  it("matches the host MCP tool payload for the same input (mirror parity)", async () => {
    const env = createTestEnv();
    const input = { repoFullName: "missing/repo", title: "Unknown repo preflight", body: "Fixes #999", changedFiles: ["docs/setup.md"] };
    const expected = buildReviewRiskExplanation({ input, repo: null, issues: [], pullRequests: [], bounties: [] });

    const app = createApp();
    const viaRest = (await (
      await app.request("/v1/preflight/review-risk", { method: "POST", headers: apiHeaders(env), body: JSON.stringify(input) }, env)
    ).json()) as {
      preflight: { status: string; repoFullName: string };
      roleContext: unknown;
      recommendation: string;
      summary: string;
    };

    const server = new LoopoverMcp(env).createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "review-risk-parity", version: "0.1.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    const viaMcp = await client.callTool({ name: "loopover_explain_review_risk", arguments: input });
    const mcpData = (viaMcp as { structuredContent?: { preflight: { status: string }; roleContext: unknown; recommendation: string } }).structuredContent;

    expect(viaRest).toMatchObject({
      summary: expected.summary,
      recommendation: expected.recommendation,
      roleContext: expected.roleContext,
      preflight: { repoFullName: expected.preflight.repoFullName, status: expected.preflight.status },
    });
    expect(mcpData).toMatchObject({
      recommendation: expected.recommendation,
      roleContext: expected.roleContext,
      preflight: { repoFullName: expected.preflight.repoFullName, status: expected.preflight.status },
    });
    expect(viaRest.recommendation).toBe(mcpData?.recommendation);
    expect(viaRest.preflight.status).toBe(mcpData?.preflight.status);
  });
});
