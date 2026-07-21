import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, startFixtureServer } from "./support/mcp-cli-harness";

// #7763: the local stdio mirror of the remote loopover_watch_issues tool and the `watch` CLI command
// (test/unit/mcp-cli-watch.test.ts, #6746). The tool only resolves the login and proxies to
// /v1/contributors/:login/watches (list=GET, watch=POST, unwatch=DELETE) -- the route stays the single
// source of truth, so these tests assert the request the tool composes and its login-resolution fallback
// chain, not the watch-subscription logic itself.
const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;
// GET (list) never reaches onWatchRequest (the fixture short-circuits before it, mirroring
// mcp-cli-watch.test.ts's own list test), so requests are tracked at the raw HTTP level here instead.
let apiRequests: string[];
let capturedRequests: Array<{ method: string; body: { repoFullName?: string; labels?: string[] } }>;

/** Connect a stdio client with `env` overlaid, so each test drives its own login-resolution scenario. */
async function connect(env: Record<string, string> = {}) {
  configDir = mkdtempSync(join(tmpdir(), "loopover-watch-issues-tool-"));
  apiRequests = [];
  capturedRequests = [];
  const apiUrl = await startFixtureServer({
    onApiRequest: (request) => apiRequests.push(`${request.method} ${request.url}`),
    onWatchRequest: (request) => capturedRequests.push(request),
  });
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) childEnv[key] = value;
  // Dropped unless a test opts back in, so the RUNNER's own env can't satisfy the login fallback by accident.
  delete childEnv.LOOPOVER_LOGIN;
  delete childEnv.GITHUB_LOGIN;
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...childEnv,
      LOOPOVER_CONFIG_DIR: configDir,
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_API_TIMEOUT_MS: "5000",
      ...env,
    },
  });
  client = new Client({ name: "watch-issues-tool-test", version: "0.0.1" });
  await client.connect(transport);
}

afterEach(async () => {
  await client?.close().catch(() => undefined);
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
});

describe("loopover_watch_issues stdio mirror (#7763)", () => {
  it("registers the tool in the stdio server tool list with a non-empty description", async () => {
    await connect({ LOOPOVER_LOGIN: "octocat" });
    const { tools } = await client.listTools();
    const tool = tools.find((entry) => entry.name === "loopover_watch_issues");
    expect(tool, "loopover_watch_issues is not registered").toBeTruthy();
    expect(tool!.description?.trim().length).toBeGreaterThan(0);
  });

  it("defaults action to list and GETs the watches, reporting the count", async () => {
    await connect({ LOOPOVER_LOGIN: "octocat" });
    const result = await client.callTool({ name: "loopover_watch_issues", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(apiRequests).toEqual(["GET /v1/contributors/octocat/watches"]);
    expect(capturedRequests).toEqual([]);
    const data = result.structuredContent as { watching: Array<{ repoFullName: string }> };
    expect(data.watching).toHaveLength(2);
    expect(JSON.stringify(result.content)).toContain("Watching 2 repo(s) for octocat");
  });

  it("watch POSTs {repoFullName,labels} and reports the change", async () => {
    await connect();
    const result = await client.callTool({
      name: "loopover_watch_issues",
      arguments: { login: "octocat", action: "watch", repoFullName: "acme/widgets", labels: ["bug", "feature"] },
    });
    expect(result.isError).toBeFalsy();
    expect(capturedRequests).toEqual([{ method: "POST", body: { repoFullName: "acme/widgets", labels: ["bug", "feature"] } }]);
    expect(JSON.stringify(result.content)).toContain("watching acme/widgets (labels: bug, feature)");
  });

  it("watch without labels sends no labels field", async () => {
    await connect();
    await client.callTool({ name: "loopover_watch_issues", arguments: { login: "octocat", action: "watch", repoFullName: "acme/widgets" } });
    expect(capturedRequests[0]!.body).toEqual({ repoFullName: "acme/widgets" });
  });

  it("unwatch DELETEs and reports it was unwatched", async () => {
    await connect();
    const result = await client.callTool({
      name: "loopover_watch_issues",
      arguments: { login: "octocat", action: "unwatch", repoFullName: "acme/widgets" },
    });
    expect(result.isError).toBeFalsy();
    expect(capturedRequests).toEqual([{ method: "DELETE", body: { repoFullName: "acme/widgets" } }]);
    expect(JSON.stringify(result.content)).toContain("unwatched acme/widgets");
  });

  it("falls back to LOOPOVER_LOGIN when no login argument is given", async () => {
    await connect({ LOOPOVER_LOGIN: "env-login" });
    const result = await client.callTool({ name: "loopover_watch_issues", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("for env-login");
  });

  it("falls back to GITHUB_LOGIN when LOOPOVER_LOGIN is unset", async () => {
    await connect({ GITHUB_LOGIN: "gh-login" });
    const result = await client.callTool({ name: "loopover_watch_issues", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain("for gh-login");
  });

  it("prefers an explicit login argument over the environment fallbacks", async () => {
    await connect({ LOOPOVER_LOGIN: "env-login", GITHUB_LOGIN: "gh-login" });
    const result = await client.callTool({ name: "loopover_watch_issues", arguments: { login: "explicit" } });
    expect(JSON.stringify(result.content)).toContain("for explicit");
  });

  it("errors with actionable guidance -- and never calls the API -- when no login resolves anywhere", async () => {
    await connect();
    const outcome = await client
      .callTool({ name: "loopover_watch_issues", arguments: {} })
      .then((r) => ({ isError: Boolean(r.isError), text: JSON.stringify(r) }), (e: unknown) => ({ isError: true, text: String(e) }));
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toMatch(/LOOPOVER_LOGIN|loopover-mcp login/);
    expect(capturedRequests).toHaveLength(0);
  });

  it("errors when watch/unwatch is missing repoFullName, without calling the API", async () => {
    await connect({ LOOPOVER_LOGIN: "octocat" });
    for (const action of ["watch", "unwatch"] as const) {
      const outcome = await client
        .callTool({ name: "loopover_watch_issues", arguments: { action } })
        .then((r) => ({ isError: Boolean(r.isError), text: JSON.stringify(r) }), (e: unknown) => ({ isError: true, text: String(e) }));
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toMatch(new RegExp(`${action} requires repoFullName`));
    }
    expect(capturedRequests).toHaveLength(0);
  });

  it("rejects invalid input (zod): a blank login and an unknown action, without calling the API", async () => {
    await connect({ LOOPOVER_LOGIN: "octocat" });
    for (const args of [{ login: "" }, { action: "bogus" }]) {
      const outcome = await client.callTool({ name: "loopover_watch_issues", arguments: args }).then(
        (r) => Boolean(r.isError),
        () => true,
      );
      expect(outcome, `${JSON.stringify(args)} should be rejected`).toBe(true);
    }
    expect(capturedRequests).toHaveLength(0);
  });
});
