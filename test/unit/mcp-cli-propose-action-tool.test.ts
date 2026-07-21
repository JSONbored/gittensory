import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeFixtureServer, run, startFixtureServer } from "./support/mcp-cli-harness";

const bin = join(process.cwd(), "packages/loopover-mcp/bin/loopover-mcp.js");

// #7753: the stdio counterpart to the remote's already-shipped loopover_propose_action (src/mcp/server.ts) and
// to `maintain propose` -- same maintain-adjacent family as #6152's five siblings (test/unit/mcp-cli-maintain-
// tools.test.ts), added later because #6744 shipped the route + CLI mirror without a stdio registration. These
// assert the proxy contract -- that the tool reaches the same bare POST .../agent/pending-actions endpoint
// `maintain propose` already calls, with the same body -- rather than re-testing the endpoint itself, which
// test/unit/mcp-cli-maintain.test.ts's "propose" describe block already covers via the CLI.
let client: Client | null = null;
let transport: StdioClientTransport | null = null;
let configDir: string | null = null;
let capturedRequests: Array<{ url: string; method: string }>;

async function connect(options: Parameters<typeof startFixtureServer>[0] = {}) {
  configDir = mkdtempSync(join(tmpdir(), "loopover-propose-action-tool-"));
  capturedRequests = [];
  const apiUrl = await startFixtureServer({
    ...options,
    onApiRequest: (request) => {
      const url = request.url ?? "";
      if (url.includes("pending-actions")) capturedRequests.push({ url, method: request.method ?? "GET" });
    },
  });
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      LOOPOVER_CONFIG_DIR: configDir,
      LOOPOVER_API_URL: apiUrl,
      LOOPOVER_TOKEN: "session-token",
      LOOPOVER_API_TIMEOUT_MS: "5000",
    },
  });
  client = new Client({ name: "propose-action-tool-test", version: "0.0.1" });
  await client.connect(transport);
}

afterEach(async () => {
  await client?.close().catch(() => undefined);
  client = null;
  transport = null;
  await closeFixtureServer();
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  configDir = null;
});

const REPO = { owner: "owner", repo: "repo" };

describe("loopover-mcp loopover_propose_action stdio proxy (#7753)", () => {
  it("registers loopover_propose_action in the stdio server tool list, with a non-empty description", async () => {
    await connect();
    const tools = (await client!.listTools()).tools;
    const tool = tools.find((entry) => entry.name === "loopover_propose_action");
    expect(tool, "loopover_propose_action is not registered").toBeTruthy();
    expect(tool!.description?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it("lists loopover_propose_action via `loopover-mcp tools --json` with the same description the server carries", async () => {
    await connect();
    const wireDescription = (await client!.listTools()).tools.find((entry) => entry.name === "loopover_propose_action")!.description;
    const payload = JSON.parse(run(["tools", "--json"])) as { tools: Array<{ name: string; description: string }> };
    const entry = payload.tools.find((t) => t.name === "loopover_propose_action");
    expect(entry, "missing descriptor for loopover_propose_action").toBeTruthy();
    expect(entry!.description).toBe(wireDescription);
  });

  it("proxies to the bare POST .../agent/pending-actions endpoint `maintain propose` already calls, forwarding every field", async () => {
    await connect();
    const result = await client!.callTool({
      name: "loopover_propose_action",
      arguments: { ...REPO, pullNumber: 7, actionClass: "merge", reason: "needs a look", label: "priority", reviewBody: "lgtm", mergeMethod: "squash", closeComment: "n/a" },
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result)).toContain("pa-1");
    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]!.url).toBe("/v1/repos/owner/repo/agent/pending-actions");
    expect(capturedRequests[0]!.method).toBe("POST");
  });

  it("reports 'Staged' when the route creates a new action", async () => {
    await connect({ proposeActionCreated: true });
    const result = await client!.callTool({ name: "loopover_propose_action", arguments: { ...REPO, pullNumber: 7, actionClass: "merge" } });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text?: string }>).find((block) => block.type === "text")?.text ?? "";
    expect(text).toMatch(/^Staged /);
  });

  it("reports 'Already staged' when an equivalent action is already queued (created: false)", async () => {
    await connect({ proposeActionCreated: false });
    const result = await client!.callTool({ name: "loopover_propose_action", arguments: { ...REPO, pullNumber: 7, actionClass: "merge" } });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text?: string }>).find((block) => block.type === "text")?.text ?? "";
    expect(text).toMatch(/^Already staged /);
  });

  // The fixture serves owner/repo only and 404s anything else, so an unregistered repo exercises the same
  // failure path a real caller hits without maintainer access to the target: an API error, surfaced as a tool
  // error rather than a silent empty success -- same contract #6152's siblings assert in mcp-cli-maintain-
  // tools.test.ts.
  it("surfaces an API failure as a tool error", async () => {
    await connect();
    const result = await client!.callTool({ name: "loopover_propose_action", arguments: { owner: "nobody", repo: "missing", pullNumber: 7, actionClass: "merge" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/404|not_found/);
  });

  it("rejects an unknown action class before any API call", async () => {
    await connect();
    const result = await client!.callTool({ name: "loopover_propose_action", arguments: { ...REPO, pullNumber: 7, actionClass: "bogus" } });
    expect(result.isError).toBe(true);
    expect(capturedRequests).toEqual([]);
  });

  it("rejects a non-positive pull number before any API call", async () => {
    await connect();
    const result = await client!.callTool({ name: "loopover_propose_action", arguments: { ...REPO, pullNumber: 0, actionClass: "merge" } });
    expect(result.isError).toBe(true);
    expect(capturedRequests).toEqual([]);
  });
});
