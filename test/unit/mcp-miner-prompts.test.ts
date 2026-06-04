import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const bin = join(process.cwd(), "packages/gittensory-mcp/bin/gittensory-mcp.js");

const FORBIDDEN_PATTERN = /wallet\s*[:=]\s*\S+|hotkey\s*[:=]\s*\S+|coldkey\s*[:=]\s*\S+|raw trust score is|your trust score|reward estimate is|estimated reward/i;

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "gittensory-miner-prompts-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      GITTENSORY_CONFIG_DIR: configDir,
      GITTENSORY_API_TIMEOUT_MS: "1000",
    },
  });
  client = new Client({ name: "miner-prompt-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

function extractText(messages: Array<{ content: unknown }>): string {
  return messages
    .map((m) => (typeof m.content === "object" && m.content !== null && "text" in m.content ? (m.content as { text: string }).text : ""))
    .join("\n");
}

describe("gittensory_miner_select_issue prompt", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("returns a user message with issue selection guidance", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_select_issue", arguments: { repoFullName: "owner/repo", login: "dev" } });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.role).toBe("user");
    const text = extractText(result.messages);
    expect(text).toContain("owner/repo");
    expect(text).toContain("dev");
    expect(text).toMatch(/select.*issue|issue.*select/i);
  });

  it("enforces the no-write human-approval boundary", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_select_issue", arguments: { repoFullName: "owner/repo", login: "dev" } });
    const text = extractText(result.messages);
    expect(text).toMatch(/do not open|do not.*comment|do not.*label|do not.*close|do not.*merge/i);
  });

  it("prohibits credential and scoring requests", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_select_issue", arguments: { repoFullName: "owner/repo", login: "dev" } });
    const text = extractText(result.messages);
    expect(text).toMatch(/do not request wallet|do not request.*hotkey|do not request.*coldkey/i);
    expect(text).toMatch(/do not predict reward|do not predict.*scoring/i);
    expect(text).not.toMatch(FORBIDDEN_PATTERN);
  });
});

describe("gittensory_miner_draft_pr_packet prompt", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("returns a user message with PR packet drafting guidance", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_draft_pr_packet", arguments: { repoFullName: "owner/repo", login: "dev" } });
    const text = extractText(result.messages);
    expect(text).toMatch(/draft|pr packet|pull request/i);
    expect(text).toContain("owner/repo");
  });

  it("enforces no-write and public-safe boundaries", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_draft_pr_packet", arguments: { repoFullName: "owner/repo", login: "dev" } });
    const text = extractText(result.messages);
    expect(text).toMatch(/do not open|do not.*merge/i);
    expect(text).toMatch(/public.?safe|no private/i);
    expect(text).not.toMatch(FORBIDDEN_PATTERN);
  });
});

describe("gittensory_miner_branch_preflight prompt", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("returns a user message with preflight guidance", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_branch_preflight", arguments: { repoFullName: "owner/repo", login: "dev" } });
    const text = extractText(result.messages);
    expect(text).toMatch(/blocker|preflight|remediation/i);
  });

  it("does not expose private scoreability in prompt text", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_branch_preflight", arguments: { repoFullName: "owner/repo", login: "dev" } });
    const text = extractText(result.messages);
    expect(text).not.toMatch(FORBIDDEN_PATTERN);
  });
});

describe("gittensory_miner_cleanup_first prompt", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("returns stale PR cleanup guidance", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_cleanup_first", arguments: { login: "dev" } });
    const text = extractText(result.messages);
    expect(text).toMatch(/stale|cleanup|close|supersede/i);
    expect(text).toContain("dev");
  });

  it("enforces no-autonomous-write boundary", async () => {
    const result = await client.getPrompt({ name: "gittensory_miner_cleanup_first", arguments: { login: "dev" } });
    const text = extractText(result.messages);
    expect(text).toMatch(/do not close.*autonomously|do not.*merge.*autonomously|do not.*comment.*autonomously/i);
    expect(text).not.toMatch(FORBIDDEN_PATTERN);
  });
});
