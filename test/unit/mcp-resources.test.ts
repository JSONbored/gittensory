import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

// Forbidden terms that must never appear in resource descriptions or content.
const FORBIDDEN_RESOURCE_TERMS =
  /wallet|hotkey|coldkey|mnemonic|seed phrase|payout|raw trust|trust score|reward estimate|farming|private reviewability|scoreability|private ranking/i;

const FIXED_RESOURCE_URIS = [
  "gittensory://doctor/status",
  "gittensory://compatibility",
  "gittensory://release/notes",
];

const RESOURCE_TEMPLATE_NAMES = ["gittensory_contributor_decision_pack"];

function contentText(content: unknown): string {
  return typeof content === "object" && content !== null && "text" in content ? String((content as { text: unknown }).text ?? "") : "";
}

async function connectTestClient() {
  const mcpServer = new GittensoryMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: "gittensory-resource-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, mcpServer };
}

// ── Resource discovery ────────────────────────────────────────────────────────

describe("MCP resource discovery", () => {
  it("lists all fixed-URI resources", async () => {
    const { client } = await connectTestClient();
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);

    for (const expected of FIXED_RESOURCE_URIS) {
      expect(uris, `expected fixed resource "${expected}" to be listed`).toContain(expected);
    }
  });

  it("lists the decision-pack URI template", async () => {
    const { client } = await connectTestClient();
    const { resourceTemplates } = await client.listResourceTemplates();
    const names = resourceTemplates.map((t) => t.name);

    for (const expected of RESOURCE_TEMPLATE_NAMES) {
      expect(names, `expected resource template "${expected}" to be listed`).toContain(expected);
    }
    expect(resourceTemplates.find((t) => t.name === "gittensory_contributor_decision_pack")?.uriTemplate).toMatch(
      /gittensory:\/\/contributor\/\{login\}\/decision-pack/,
    );
  });

  it("resource descriptions do not expose forbidden terms", async () => {
    const { client } = await connectTestClient();
    const [{ resources }, { resourceTemplates }] = await Promise.all([client.listResources(), client.listResourceTemplates()]);

    for (const resource of resources) {
      expect(resource.description ?? "", `resource "${resource.uri}" description must not contain forbidden terms`).not.toMatch(FORBIDDEN_RESOURCE_TERMS);
    }
    for (const template of resourceTemplates) {
      expect(template.description ?? "", `resource template "${template.name}" description must not contain forbidden terms`).not.toMatch(FORBIDDEN_RESOURCE_TERMS);
    }
  });

  it("resource inventory is stable — fails if any resource is removed", async () => {
    const { mcpServer } = await connectTestClient();
    const registeredResources = (mcpServer as unknown as { _registeredResources: Record<string, unknown> })._registeredResources;
    const registeredTemplates = (mcpServer as unknown as { _registeredResourceTemplates: Record<string, unknown> })._registeredResourceTemplates;

    for (const uri of FIXED_RESOURCE_URIS) {
      expect(Object.keys(registeredResources), `expected resource "${uri}" to remain registered`).toContain(uri);
    }
    for (const name of RESOURCE_TEMPLATE_NAMES) {
      expect(Object.keys(registeredTemplates), `expected resource template "${name}" to remain registered`).toContain(name);
    }
  });

  it("reading a non-existent resource URI fails safely", async () => {
    const { client } = await connectTestClient();
    await expect(client.readResource({ uri: "gittensory://nonexistent/resource" })).rejects.toThrow();
  });
});

// ── Resource read tests ───────────────────────────────────────────────────────

describe("MCP resource reads", () => {
  it("reads doctor/status and returns valid JSON with upstream and registry fields", async () => {
    const { client } = await connectTestClient();
    const result = await client.readResource({ uri: "gittensory://doctor/status" });

    expect(result.contents).toHaveLength(1);
    const content = result.contents[0]!;
    expect(content.uri).toBe("gittensory://doctor/status");
    expect(content.mimeType).toBe("application/json");

    const data = JSON.parse(contentText(content));
    expect(data).toHaveProperty("upstream");
    expect(data).toHaveProperty("registry");
    expect(data).toHaveProperty("apiAvailable", true);
    expect(["current", "drift_detected", "stale", "unavailable"]).toContain(data.upstream.status);
  });

  it("reads compatibility and returns server version and protocol info", async () => {
    const { client } = await connectTestClient();
    const result = await client.readResource({ uri: "gittensory://compatibility" });

    expect(result.contents).toHaveLength(1);
    const content = result.contents[0]!;
    expect(content.mimeType).toBe("application/json");

    const data = JSON.parse(contentText(content));
    expect(data.serverName).toBe("gittensory");
    expect(data.serverVersion).toBeDefined();
    expect(Array.isArray(data.supportedProtocolVersions)).toBe(true);
    expect(data.supportedProtocolVersions.length).toBeGreaterThan(0);
    expect(data.minimumClientPackage).toBeDefined();
  });

  it("reads release/notes and returns version and changelog reference", async () => {
    const { client } = await connectTestClient();
    const result = await client.readResource({ uri: "gittensory://release/notes" });

    expect(result.contents).toHaveLength(1);
    const content = result.contents[0]!;
    expect(content.mimeType).toBe("application/json");

    const data = JSON.parse(contentText(content));
    expect(data.serverVersion).toBeDefined();
    expect(data.changelogUrl).toMatch(/github\.com/);
    expect(data.note).toBeDefined();
  });

  it("reads contributor decision pack resource via URI template", async () => {
    const { client } = await connectTestClient();
    const result = await client.readResource({ uri: "gittensory://contributor/test-user/decision-pack" });

    expect(result.contents).toHaveLength(1);
    const content = result.contents[0]!;
    expect(content.uri).toBe("gittensory://contributor/test-user/decision-pack");
    expect(content.mimeType).toBe("application/json");

    const data = JSON.parse(contentText(content));
    // Decision pack is returned (may be empty/stale but the shape is present)
    expect(typeof data).toBe("object");
    expect(data).not.toBeNull();
  });
});

// ── Resource content safety ───────────────────────────────────────────────────

describe("MCP resource content safety", () => {
  it("doctor/status content does not expose forbidden terms", async () => {
    const { client } = await connectTestClient();
    const result = await client.readResource({ uri: "gittensory://doctor/status" });
    const text = contentText(result.contents[0]);
    expect(text).not.toMatch(FORBIDDEN_RESOURCE_TERMS);
  });

  it("compatibility content does not expose forbidden terms", async () => {
    const { client } = await connectTestClient();
    const result = await client.readResource({ uri: "gittensory://compatibility" });
    const text = contentText(result.contents[0]);
    expect(text).not.toMatch(FORBIDDEN_RESOURCE_TERMS);
  });

  it("release/notes content does not expose forbidden terms", async () => {
    const { client } = await connectTestClient();
    const result = await client.readResource({ uri: "gittensory://release/notes" });
    const text = contentText(result.contents[0]);
    expect(text).not.toMatch(FORBIDDEN_RESOURCE_TERMS);
  });

  it("decision pack content does not expose sensitive financial fields", async () => {
    const { client } = await connectTestClient();
    const result = await client.readResource({ uri: "gittensory://contributor/test-user/decision-pack" });
    const text = contentText(result.contents[0]);
    expect(text).not.toMatch(/hotkey|coldkey|wallet|mnemonic|alphaPerDay|taoPerDay|usdPerDay/i);
    expect(text).not.toMatch(FORBIDDEN_RESOURCE_TERMS);
  });
});
