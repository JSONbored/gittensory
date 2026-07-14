import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { AuthIdentity } from "../../src/auth/security";
import { createSessionForGitHubUser } from "../../src/auth/security";
import { recordAuditEvent, upsertInstallation, upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { LoopoverMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect(env: Env, identity: AuthIdentity) {
  const server = new LoopoverMcp(env, identity).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-skipped-pr-audit-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function seedSkippedPrAudit(env: Env) {
  await upsertInstallation(env, {
    installation: {
      id: 101,
      account: { login: "repo-owner", id: 101, type: "User" },
      repository_selection: "selected",
      permissions: { metadata: "read", pull_requests: "read", issues: "write" },
      events: ["pull_request", "repository"],
    },
  });
  await upsertRepositoryFromGitHub(
    env,
    { name: "owned-repo", full_name: "repo-owner/owned-repo", private: false, default_branch: "main", owner: { login: "repo-owner" } },
    101,
  );
  await upsertInstallation(env, {
    installation: {
      id: 202,
      account: { login: "victim-org", id: 202, type: "Organization" },
      repository_selection: "selected",
      permissions: { metadata: "read", pull_requests: "read", issues: "write" },
      events: ["pull_request", "repository"],
    },
  });
  await upsertRepositoryFromGitHub(
    env,
    { name: "secret-repo", full_name: "victim-org/secret-repo", private: true, default_branch: "main", owner: { login: "victim-org" } },
    202,
  );
  const secretMetadata = { deliveryId: "delivery-secret", token: "github_pat_should_not_export", privateNote: "wallet hotkey raw trust" };
  await recordAuditEvent(env, {
    eventType: "github_app.pr_visibility_skipped",
    actor: "legacy-secret",
    targetKey: "repo-owner/owned-repo#1",
    outcome: "completed",
    detail: "legacy_skip_reason",
    metadata: secretMetadata,
    createdAt: "2026-05-28T00:00:00.250Z",
  });
  await recordAuditEvent(env, {
    eventType: "github_app.pr_visibility_skipped",
    actor: "missing-secret",
    targetKey: "repo-owner/owned-repo#2",
    outcome: "completed",
    detail: "missing_author",
    metadata: secretMetadata,
    createdAt: "2026-05-28T00:00:00.500Z",
  });
  await recordAuditEvent(env, {
    eventType: "github_app.pr_visibility_skipped",
    actor: "private-author",
    targetKey: "repo-owner/owned-repo#3",
    outcome: "completed",
    detail: "not_official_gittensor_miner",
    metadata: secretMetadata,
    createdAt: "2026-05-28T00:00:01.000Z",
  });
  await recordAuditEvent(env, {
    eventType: "github_app.pr_visibility_skipped",
    actor: "bot-secret",
    targetKey: "repo-owner/owned-repo#4",
    outcome: "completed",
    detail: "bot_author",
    metadata: secretMetadata,
    createdAt: "2026-05-28T00:00:02.000Z",
  });
  await recordAuditEvent(env, {
    eventType: "github_app.pr_visibility_skipped",
    actor: "detector-secret",
    targetKey: "repo-owner/owned-repo#5",
    outcome: "completed",
    detail: "miner_detection_unavailable",
    metadata: secretMetadata,
    createdAt: "2026-05-28T00:00:03.000Z",
  });
  await recordAuditEvent(env, {
    eventType: "github_app.pr_visibility_skipped",
    actor: "surface-secret",
    targetKey: "repo-owner/owned-repo#6",
    outcome: "completed",
    detail: "surface_off",
    metadata: secretMetadata,
    createdAt: "2026-05-28T00:00:04.000Z",
  });
  await recordAuditEvent(env, {
    eventType: "github_app.pr_visibility_skipped",
    actor: "victim-secret",
    targetKey: "victim-org/secret-repo#7",
    outcome: "completed",
    detail: "maintainer_author",
    metadata: secretMetadata,
    createdAt: "2026-05-28T00:00:05.000Z",
  });
}

async function ownerIdentity(env: Env): Promise<AuthIdentity> {
  const { session } = await createSessionForGitHubUser(env, { login: "repo-owner", id: 101 });
  return {
    kind: "session",
    actor: "repo-owner",
    session,
  };
}

describe("MCP loopover_get_skipped_pr_audit (#5825)", () => {
  it("returns the default scoped audit page for an owner/maintainer session with no filters", async () => {
    const env = createTestEnv();
    await seedSkippedPrAudit(env);
    const client = await connect(env, await ownerIdentity(env));
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
    expect(data.items).toHaveLength(6);
    expect(data.items.map((item) => item.pullNumber)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(JSON.stringify(data)).not.toContain("victim-org");
    expect(JSON.stringify(data)).not.toMatch(/delivery-secret|github_pat|wallet|hotkey|raw trust/i);
  });

  it("applies repoFullName, reason, and since filters individually", async () => {
    const env = createTestEnv();
    await seedSkippedPrAudit(env);
    const client = await connect(env, await ownerIdentity(env));

    const repoFiltered = await client.callTool({
      name: "loopover_get_skipped_pr_audit",
      arguments: { repoFullName: "repo-owner/owned-repo" },
    });
    expect((repoFiltered.structuredContent as { items: Array<{ repoFullName: string }> }).items.every((item) => item.repoFullName === "repo-owner/owned-repo")).toBe(true);

    const reasonFiltered = await client.callTool({
      name: "loopover_get_skipped_pr_audit",
      arguments: { reason: "bot_author" },
    });
    expect((reasonFiltered.structuredContent as { items: Array<{ reason: string; pullNumber: number }> }).items).toEqual([
      expect.objectContaining({ reason: "bot_author", pullNumber: 4 }),
    ]);

    const sinceFiltered = await client.callTool({
      name: "loopover_get_skipped_pr_audit",
      arguments: { since: "2026-05-28T00:00:03.500Z" },
    });
    expect((sinceFiltered.structuredContent as { filters: { since: string | null } }).filters.since).toBe("2026-05-28T00:00:03.500Z");
    expect((sinceFiltered.structuredContent as { items: Array<{ pullNumber: number }> }).items.map((item) => item.pullNumber)).toEqual([6]);
  });

  it("clamps limit to the same 1..100 bounds as the route", async () => {
    const env = createTestEnv();
    await seedSkippedPrAudit(env);
    const client = await connect(env, await ownerIdentity(env));

    const lowerBound = await client.callTool({
      name: "loopover_get_skipped_pr_audit",
      arguments: { limit: 0 },
    });
    expect((lowerBound.structuredContent as { limit: number; items: Array<{ pullNumber: number }> }).limit).toBe(1);
    expect((lowerBound.structuredContent as { items: Array<{ pullNumber: number }> }).items).toEqual([expect.objectContaining({ pullNumber: 6 })]);

    const upperBound = await client.callTool({
      name: "loopover_get_skipped_pr_audit",
      arguments: { limit: 500 },
    });
    expect((upperBound.structuredContent as { limit: number; items: Array<{ pullNumber: number }> }).limit).toBe(100);
    expect((upperBound.structuredContent as { items: Array<{ pullNumber: number }> }).items).toHaveLength(6);
  });

  it("returns an empty result when filters match no scoped audit events", async () => {
    const env = createTestEnv();
    await seedSkippedPrAudit(env);
    const client = await connect(env, await ownerIdentity(env));
    const result = await client.callTool({
      name: "loopover_get_skipped_pr_audit",
      arguments: { reason: "maintainer_author" },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { hasMore: boolean; items: unknown[] };
    expect(data.hasMore).toBe(false);
    expect(data.items).toEqual([]);
  });

  it("forbids non-maintainer callers", async () => {
    const env = createTestEnv();
    await seedSkippedPrAudit(env);
    const client = await connect(env, { kind: "static", actor: "mcp" });
    const result = await client.callTool({ name: "loopover_get_skipped_pr_audit", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("maintainer access is required");
  });
});
