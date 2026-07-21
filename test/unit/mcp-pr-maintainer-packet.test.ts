import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { upsertPullRequestFromGitHub, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env) {
  const server = new LoopoverMcp(env).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "loopover-maintainer-packet-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

function prPayload(overrides: Record<string, unknown> = {}) {
  return {
    number: 7,
    title: "Add retry to the upload client",
    state: "open",
    user: { login: "contributor" },
    author_association: "CONTRIBUTOR",
    head: { sha: "abc123", ref: "contributor/attempt-1" },
    base: { ref: "main" },
    html_url: "https://github.com/owner/repo/pull/7",
    merged_at: null,
    draft: false,
    mergeable: true,
    body: "Closes #1",
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-07-03T00:00:00Z",
    closed_at: null,
    labels: [{ name: "enhancement" }],
    ...overrides,
  };
}

describe("MCP loopover_get_pr_maintainer_packet (#7802)", () => {
  it("forbids the static mcp identity when the repo is outside MCP_READ_REPO_ALLOWLIST", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "" });
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_pr_maintainer_packet", arguments: { owner: "owner", repo: "repo", number: 7 } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ status: "forbidden", repoFullName: "owner/repo" });
  });

  it("returns the maintainer packet assembled from cached metadata", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" }, default_branch: "main" });
    await upsertPullRequestFromGitHub(env, "owner/repo", prPayload());
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_pr_maintainer_packet", arguments: { owner: "owner", repo: "repo", number: 7 } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data.repoFullName).toBe("owner/repo");
    expect(data.pullNumber).toBe(7);
    expect(data.dataQuality).toBeDefined();
    expect(JSON.stringify(data)).not.toMatch(/hotkey|coldkey|wallet|payout|reward/i);
  });
});
