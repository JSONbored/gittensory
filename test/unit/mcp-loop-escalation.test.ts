import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect() {
  const server = new LoopoverMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-escalation-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("MCP loopover_evaluate_escalation", () => {
  it("does not escalate a healthy loop", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_evaluate_escalation",
      arguments: { runStatus: "running", healthStatus: "healthy" },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { shouldEscalate: boolean; action: string };
    expect(data.shouldEscalate).toBe(false);
    expect(data.action).toBe("none");
  });

  it("routes a failing loop to human review with reasons", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_evaluate_escalation",
      arguments: { runStatus: "error", healthStatus: "critical" },
    });
    const data = result.structuredContent as { shouldEscalate: boolean; action: string; severity: string; reasons: string[] };
    expect(data).toMatchObject({ shouldEscalate: true, action: "human_review", severity: "high" });
    expect(data.reasons).toEqual(expect.arrayContaining(["run_errored", "health_critical"]));
  });
});
