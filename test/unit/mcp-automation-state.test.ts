import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { createPendingAgentActionIfAbsent, upsertInstallation, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env) {
  const server = new GittensoryMcp(env).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-automation-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

type State = {
  configured: boolean;
  autonomy: Record<string, string>;
  agentPaused: boolean;
  agentDryRun: boolean;
  mode: string;
  permissionReadiness: string;
  actingActionClasses: string[];
  pendingActionCount: number;
};

describe("MCP gittensory_get_automation_state (#784)", () => {
  it("surfaces a configured repo's autonomy, mode, readiness, and pending-approval count", async () => {
    const env = createTestEnv();
    await upsertRepositoryFromGitHub(env, { name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }, 5);
    await upsertInstallation(env, {
      installation: { id: 5, account: { login: "owner", id: 1, type: "User" }, repository_selection: "selected", permissions: { metadata: "read", pull_requests: "write", issues: "write" }, events: ["pull_request"] },
      repositories: [{ name: "repo", full_name: "owner/repo", private: false, owner: { login: "owner" } }],
    });
    await upsertRepositorySettings(env, { repoFullName: "owner/repo", autonomy: { merge: "auto", label: "auto_with_approval" }, agentDryRun: true });
    await createPendingAgentActionIfAbsent(env, { repoFullName: "owner/repo", pullNumber: 7, installationId: 5, actionClass: "merge", autonomyLevel: "auto_with_approval", params: {}, reason: "x" });

    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_get_automation_state", arguments: { owner: "owner", repo: "repo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as State;
    expect(data.configured).toBe(true);
    expect(data.mode).toBe("dry_run"); // agentDryRun → dry_run
    expect(data.permissionReadiness).toBe("ready"); // pull_requests: write granted
    expect(data.actingActionClasses).toEqual(expect.arrayContaining(["merge", "label"]));
    expect(data.pendingActionCount).toBe(1);
    // surfaces the COUNT, not the queue details — no reward/wallet leakage either
    expect(JSON.stringify(data)).not.toMatch(/wallet|hotkey|reward|payout|trust score/i);
  });

  it("reports unconfigured + not_required readiness for an unknown / un-onboarded repo (no repo record)", async () => {
    const env = createTestEnv();
    // no repo seeded → getRepository returns null (exercises the no-installation path) + default settings.
    const client = await connect(env);
    const result = await client.callTool({ name: "gittensory_get_automation_state", arguments: { owner: "owner", repo: "ghost" } });
    const data = result.structuredContent as State;
    expect(data.configured).toBe(false);
    expect(data.actingActionClasses).toEqual([]);
    expect(data.permissionReadiness).toBe("not_required"); // no acting PR-write class
    expect(data.pendingActionCount).toBe(0);
    expect(data.mode).toBe("live"); // nothing paused or dry-run
  });
});
