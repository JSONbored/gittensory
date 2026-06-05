import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, type ClientCapabilities } from "@modelcontextprotocol/sdk/types.js";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connectTestClient(capabilities: ClientCapabilities, env = createTestEnv()) {
  const mcpServer = new GittensoryMcp(env).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: "gittensory-branch-test", version: "0.1.0" }, { capabilities });
  await client.connect(clientTransport);
  return { client, mcpServer };
}

describe("gittensory_monitor_open_prs", () => {
  it("returns open PR monitor summary for a known login", async () => {
    const { client, mcpServer } = await connectTestClient({});
    const result = await client.callTool({ name: "gittensory_monitor_open_prs", arguments: { login: "oktofeesh1" } });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).toMatchObject({ login: "oktofeesh1", summary: expect.any(String) });
    expect(JSON.stringify(data)).not.toMatch(/wallet|hotkey|coldkey|reward estimate|payout|farming/i);
    await mcpServer.close();
  });
});

describe("gittensory_get_issue_quality computed source", () => {
  it("returns computed source when no snapshot exists for a known repo", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, {
      name: "mcp-branch-issue-quality",
      full_name: "entrius/mcp-branch-issue-quality",
      private: false,
      default_branch: "main",
      owner: { login: "entrius" },
    });
    const { client, mcpServer } = await connectTestClient({}, env);
    const result = await client.callTool({
      name: "gittensory_get_issue_quality",
      arguments: { owner: "entrius", repo: "mcp-branch-issue-quality" },
    });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).toMatchObject({ status: "ready", source: "computed", repoFullName: "entrius/mcp-branch-issue-quality" });
    await mcpServer.close();
  });
});

describe("gittensory_get_repo_outcome_patterns computed source", () => {
  it("returns computed source when no snapshot exists for a known repo", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, {
      name: "mcp-branch-outcome-patterns",
      full_name: "entrius/mcp-branch-outcome-patterns",
      private: false,
      default_branch: "main",
      owner: { login: "entrius" },
    });
    const { client, mcpServer } = await connectTestClient({}, env);
    const result = await client.callTool({
      name: "gittensory_get_repo_outcome_patterns",
      arguments: { owner: "entrius", repo: "mcp-branch-outcome-patterns" },
    });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).toMatchObject({ status: "ready", source: "computed", repoFullName: "entrius/mcp-branch-outcome-patterns" });
    await mcpServer.close();
  });
});

describe("planning elicitation sendRequest error fallback", () => {
  it("returns accepted: false when sendRequest throws", async () => {
    const { client, mcpServer } = await connectTestClient({ elicitation: { form: {} } });
    client.setRequestHandler(ElicitRequestSchema, async () => {
      throw new Error("simulated elicitation transport failure");
    });
    const result = await client.callTool({ name: "gittensory_agent_plan_next_work", arguments: { login: "oktofeesh1" } });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.planningElicitation).toMatchObject({ supported: true, requested: true, accepted: false });
    await mcpServer.close();
  });
});
