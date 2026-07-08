import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { GittensoryMcp } from "../../src/mcp/server";
import { SLOP_RULES_URI } from "../../src/review/slop-rules-taxonomy";
import { ISSUE_SLOP_WEIGHTS, SLOP_WEIGHTS } from "../../src/signals/slop";
import { createTestEnv } from "../helpers/d1";

async function connectTestClient() {
  const mcpServer = new GittensoryMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: "gittensory-slop-rules-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, mcpServer };
}

describe("MCP slop-rules resource (#2237)", () => {
  it("discovers the slop-rules resource", async () => {
    const { client } = await connectTestClient();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(SLOP_RULES_URI);
  });

  it("returns every rule code and score band as JSON", async () => {
    const { client } = await connectTestClient();
    const result = await client.readResource({ uri: SLOP_RULES_URI });
    expect(result.contents).toHaveLength(1);
    const content = result.contents[0];
    expect(content?.mimeType).toBe("application/json");
    if (!content || !("text" in content)) throw new Error("expected text content");
    const body = JSON.parse(content.text ?? "") as {
      bands: Array<{ band: string; range: string }>;
      pullRequestRules: Array<{ code: string; weight: number }>;
      issueRules: Array<{ code: string; weight: number }>;
    };
    const prCodes = body.pullRequestRules.map((rule) => rule.code);
    for (const code of Object.keys(SLOP_WEIGHTS)) expect(prCodes).toContain(code);
    const issueCodes = body.issueRules.map((rule) => rule.code);
    for (const code of Object.keys(ISSUE_SLOP_WEIGHTS)) expect(issueCodes).toContain(code);
    expect(body.bands.map((band) => band.band)).toEqual(["clean", "low", "elevated", "high"]);
  });
});
