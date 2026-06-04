import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const bin = join(process.cwd(), "packages/gittensory-mcp/bin/gittensory-mcp.js");

let client: Client;
let transport: StdioClientTransport;
let configDir: string;

async function connect() {
  configDir = mkdtempSync(join(tmpdir(), "gittensory-schemas-"));
  transport = new StdioClientTransport({
    command: "node",
    args: [bin, "--stdio"],
    env: {
      ...process.env,
      GITTENSORY_CONFIG_DIR: configDir,
      GITTENSORY_API_TIMEOUT_MS: "1000",
    },
  });
  client = new Client({ name: "schema-test", version: "0.0.1" });
  await client.connect(transport);
}

async function disconnect() {
  await client.close().catch(() => undefined);
  if (configDir) rmSync(configDir, { recursive: true, force: true });
}

describe("MCP structured output schemas", () => {
  beforeEach(connect);
  afterEach(disconnect);

  it("gittensory_local_status_structured tool is discoverable", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "gittensory_local_status_structured");
    expect(tool).toBeDefined();
    expect(tool?.description).toMatch(/local.*status|status.*structured/i);
  });

  it("gittensory_local_status_structured tool has an output schema", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "gittensory_local_status_structured");
    expect(tool?.outputSchema).toBeDefined();
    const schema = tool?.outputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    const properties = schema.properties as Record<string, unknown>;
    expect(properties).toHaveProperty("apiUrl");
    expect(properties).toHaveProperty("hasToken");
    expect(properties).toHaveProperty("package");
    expect(properties).toHaveProperty("sourceUploadDefault");
    expect(properties).toHaveProperty("sourceUploadSupported");
  });

  it("all existing tools remain discoverable and are not broken by schema additions", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("gittensory_get_repo_context");
    expect(names).toContain("gittensory_preflight_pr");
    expect(names).toContain("gittensory_get_decision_pack");
    expect(names).toContain("gittensory_local_status");
    expect(names).toContain("gittensory_preflight_current_branch");
    expect(names).toContain("gittensory_agent_plan_next_work");
    expect(names).toContain("gittensory_agent_prepare_pr_packet");
  });

  it("tools do not expose private or forbidden fields in their descriptions", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const text = tool.description ?? "";
      expect(text).not.toMatch(/wallet address|hotkey|coldkey|raw trust score|private scoreability ranking/i);
    }
  });
});
