import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { upsertRepositoryFromGitHub } from "../../src/db/repositories";
import { generateContributorIssueDrafts } from "../../src/services/contributor-issue-draft";
import type { AuthIdentity } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

const REPO = "owner/widgets";

async function connect(env: Env, identity?: AuthIdentity) {
  const server = (identity ? new LoopoverMcp(env, identity) : new LoopoverMcp(env)).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-issue-drafts-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

async function seedRepo(env: ReturnType<typeof createTestEnv>): Promise<void> {
  await upsertRepositoryFromGitHub(env, { name: "widgets", full_name: REPO, private: false, owner: { login: "owner" }, default_branch: "main" }, 555);
}

// The api static identity is unconditionally trusted (like the refresh-repo-docs test), so it exercises the
// happy path without needing an actuation allowlist.
const API_IDENTITY = { kind: "static", actor: "api" } as AuthIdentity;

describe("MCP loopover_generate_contributor_issue_drafts (#6757)", () => {
  it("previews drafts on a dry run and returns only counts + posture (no draft bodies)", async () => {
    const env = createTestEnv();
    await seedRepo(env);
    const client = await connect(env, API_IDENTITY);
    const result = await client.callTool({ name: "loopover_generate_contributor_issue_drafts", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).toMatchObject({ repoFullName: REPO, dryRun: true, createRequested: false, created: 0 });
    // Public-safe: the free-form drafts[] (title/body) never leaves on the tool result — only the counts do.
    expect(data.drafts).toBeUndefined();
    expect(typeof data.proposed).toBe("number");
  });

  it("REJECTS create without an explicit dryRun:false — the tool can never silently create (#6757)", async () => {
    const env = createTestEnv();
    await seedRepo(env);
    const client = await connect(env, API_IDENTITY);
    const result = await client.callTool({ name: "loopover_generate_contributor_issue_drafts", arguments: { owner: "owner", repo: "widgets", create: true } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/explicit_create_requires_dry_run_false/);
  });

  it("denies a static MCP-token caller when the repo is not in MCP_ACTUATION_REPO_ALLOWLIST", async () => {
    const env = createTestEnv({ MCP_ACTUATION_REPO_ALLOWLIST: "" });
    await seedRepo(env);
    const client = await connect(env); // default identity: { kind: "static", actor: "mcp" }
    const result = await client.callTool({ name: "loopover_generate_contributor_issue_drafts", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/MCP_ACTUATION_REPO_ALLOWLIST/);
  });

  it("allows an operator session and attributes the request to that actor", async () => {
    // ADMIN_GITHUB_LOGINS grants operator scope, so requireRepoManageAccess admits this session actor and the
    // handler takes its `this.identity.actor` requestedBy branch (the primary real caller is a session, not a token).
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "maintainer-login" });
    await seedRepo(env);
    const client = await connect(env, { kind: "session", actor: "maintainer-login" } as AuthIdentity);
    const result = await client.callTool({ name: "loopover_generate_contributor_issue_drafts", arguments: { owner: "owner", repo: "widgets" } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ repoFullName: REPO, dryRun: true, createRequested: false });
  });

  it("the MCP tool's counts mirror the underlying service for identical input (surface parity)", async () => {
    const env = createTestEnv();
    await seedRepo(env);
    // The service is the single source of truth both the REST route and this MCP tool delegate to; asserting
    // the tool's structuredContent equals a direct service call for the same input pins that the MCP surface
    // reshapes without altering the numbers.
    const direct = await generateContributorIssueDrafts(env, REPO, { dryRun: true, limit: 5, requestedBy: "api" });
    const client = await connect(env, API_IDENTITY);
    const result = await client.callTool({ name: "loopover_generate_contributor_issue_drafts", arguments: { owner: "owner", repo: "widgets", limit: 5 } });
    const data = result.structuredContent as Record<string, unknown>;
    expect(data).toMatchObject({
      repoFullName: direct.repoFullName,
      dryRun: direct.dryRun,
      createRequested: direct.createRequested,
      proposed: direct.proposed,
      skippedDuplicate: direct.skippedDuplicate,
      skippedDeclined: direct.skippedDeclined,
      skippedUnsafe: direct.skippedUnsafe,
      created: direct.created,
      skippedCreateFailed: direct.skippedCreateFailed,
    });
  });
});
