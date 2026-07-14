import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createSessionForGitHubUser, type AuthIdentity } from "../../src/auth/security";
import { recordAuditEvent, upsertInstallation, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { LoopoverMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env, identity?: AuthIdentity): Promise<Client> {
  const server = (identity ? new LoopoverMcp(env, identity) : new LoopoverMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-skipped-pr-audit-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function seedSkipEvents(env: Env): Promise<void> {
  await upsertInstallation(env, {
    installation: {
      id: 101,
      account: { login: "repo-owner", id: 101, type: "User" },
      repository_selection: "selected",
      permissions: { metadata: "read", pull_requests: "read", issues: "write" },
      events: ["pull_request", "repository"],
    },
  });
  await upsertRepositoryFromGitHub(env, { name: "owned-repo", full_name: "repo-owner/owned-repo", private: false, default_branch: "main", owner: { login: "repo-owner" } }, 101);
  await upsertInstallation(env, {
    installation: {
      id: 202,
      account: { login: "victim-org", id: 202, type: "Organization" },
      repository_selection: "selected",
      permissions: { metadata: "read", pull_requests: "read", issues: "write" },
      events: ["pull_request", "repository"],
    },
  });
  await upsertRepositoryFromGitHub(env, { name: "secret-repo", full_name: "victim-org/secret-repo", private: true, default_branch: "main", owner: { login: "victim-org" } }, 202);

  await recordAuditEvent(env, { eventType: "github_app.pr_visibility_skipped", targetKey: "repo-owner/owned-repo#1", outcome: "completed", detail: "surface_off", createdAt: "2026-05-28T00:00:01.000Z" });
  await recordAuditEvent(env, { eventType: "github_app.pr_visibility_skipped", targetKey: "repo-owner/owned-repo#2", outcome: "completed", detail: "bot_author", createdAt: "2026-05-28T00:00:02.000Z" });
  await recordAuditEvent(env, { eventType: "github_app.pr_visibility_skipped", targetKey: "victim-org/secret-repo#3", outcome: "completed", detail: "maintainer_author", createdAt: "2026-05-28T00:00:03.000Z" });
}

describe("MCP loopover_get_skipped_pr_audit (#5825)", () => {
  it("returns the unscoped audit trail for a trusted (static, wildcard-allowlisted) identity with no filters", async () => {
    const env = createTestEnv();
    await seedSkipEvents(env);
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: {} });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as {
      limit: number;
      hasMore: boolean;
      filters: { repoFullName: string | null; reason: string | null; since: string | null };
      items: Array<{ repoFullName: string; pullNumber: number; reason: string; remediation: string }>;
    };
    expect(data.limit).toBe(50);
    expect(data.hasMore).toBe(false);
    expect(data.filters).toEqual({ repoFullName: null, reason: null, since: null });
    expect(data.items).toHaveLength(3);
    expect(data.items[0]).toMatchObject({ repoFullName: "victim-org/secret-repo", pullNumber: 3, reason: "maintainer_author" });
    expect(data.items[0]?.remediation).toContain("maintainer-authored");
  });

  it("filters by repoFullName", async () => {
    const env = createTestEnv();
    await seedSkipEvents(env);
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { repoFullName: "repo-owner/owned-repo" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { filters: { repoFullName: string | null }; items: Array<{ repoFullName: string }> };
    expect(data.filters.repoFullName).toBe("repo-owner/owned-repo");
    expect(data.items).toHaveLength(2);
    expect(data.items.every((item) => item.repoFullName === "repo-owner/owned-repo")).toBe(true);
  });

  it("filters by reason", async () => {
    const env = createTestEnv();
    await seedSkipEvents(env);
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { reason: "bot_author" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { filters: { reason: string | null }; items: Array<{ reason: string; pullNumber: number }> };
    expect(data.filters.reason).toBe("bot_author");
    expect(data.items).toEqual([expect.objectContaining({ reason: "bot_author", pullNumber: 2 })]);
  });

  it("filters by since and rejects an unparseable since value", async () => {
    const env = createTestEnv();
    await seedSkipEvents(env);
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { since: "2026-05-28T00:00:02.500Z" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { filters: { since: string | null }; items: Array<{ pullNumber: number }> };
    expect(data.filters.since).toBe("2026-05-28T00:00:02.500Z");
    expect(data.items.map((item) => item.pullNumber)).toEqual([3]);

    const invalid = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { since: "not-a-date" } });
    expect(invalid.isError).toBeTruthy();
    expect(JSON.stringify(invalid.content)).toMatch(/invalid since/i);
  });

  it("clamps limit to the route's 1-100 bounds", async () => {
    const env = createTestEnv();
    await seedSkipEvents(env);
    const client = await connect(env);
    const tooLow = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { limit: 0 } });
    expect(tooLow.isError).toBeFalsy();
    expect((tooLow.structuredContent as { limit: number }).limit).toBe(1);
    const tooHigh = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { limit: 500 } });
    expect(tooHigh.isError).toBeFalsy();
    expect((tooHigh.structuredContent as { limit: number }).limit).toBe(100);
  });

  it("returns an empty result when nothing matches", async () => {
    const env = createTestEnv();
    await seedSkipEvents(env);
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { reason: "ignored_author" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { items: unknown[]; hasMore: boolean };
    expect(data.items).toEqual([]);
    expect(data.hasMore).toBe(false);
  });

  it("forbids a session with no maintainer/owner/operator role", async () => {
    const env = createTestEnv();
    await seedSkipEvents(env);
    const { session } = await createSessionForGitHubUser(env, { login: "rando", id: 999 });
    const client = await connect(env, { kind: "session", actor: "rando", session });
    const result = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: {} });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/maintainer, owner, or operator role/i);
  });

  it("scopes a maintainer session to its own repos and forbids an out-of-scope repoFullName", async () => {
    const env = createTestEnv();
    await seedSkipEvents(env);
    const { session } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 101 });
    const client = await connect(env, { kind: "session", actor: "repo-owner", session });

    const scoped = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: {} });
    expect(scoped.isError).toBeFalsy();
    const scopedData = scoped.structuredContent as { items: Array<{ repoFullName: string }> };
    expect(scopedData.items).toHaveLength(2);
    expect(scopedData.items.every((item) => item.repoFullName === "repo-owner/owned-repo")).toBe(true);

    const forbidden = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { repoFullName: "victim-org/secret-repo" } });
    expect(forbidden.isError).toBeTruthy();
    expect(JSON.stringify(forbidden.content)).toMatch(/cannot access the skipped-PR audit/i);
  });

  it("scopes the static mcp identity to MCP_READ_REPO_ALLOWLIST for a repo-scoped request", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "repo-owner/owned-repo" });
    await seedSkipEvents(env);
    const client = await connect(env);

    const allowed = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { repoFullName: "repo-owner/owned-repo" } });
    expect(allowed.isError).toBeFalsy();

    const denied = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: { repoFullName: "victim-org/secret-repo" } });
    expect(denied.isError).toBeTruthy();
    expect(JSON.stringify(denied.content)).toMatch(/not authorized for the skipped-PR audit/i);
  });

  it("forbids the static mcp identity from an unscoped (all-repos) request without the wildcard opt-in", async () => {
    const env = createTestEnv({ MCP_READ_REPO_ALLOWLIST: "repo-owner/owned-repo" });
    await seedSkipEvents(env);
    const client = await connect(env);
    const result = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: {} });
    expect(result.isError).toBeTruthy();
    expect(JSON.stringify(result.content)).toMatch(/not authorized for the skipped-PR audit/i);
  });
});
