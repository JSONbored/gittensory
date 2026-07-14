import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect() {
  const server = new LoopoverMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-health-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("MCP loopover_evaluate_loop_health", () => {
  it("returns a healthy verdict for a nominal loop", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_evaluate_loop_health",
      arguments: { iteration: 1, maxIterations: 5, costUsed: 10, costCeiling: 100 },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { status: string; anomalies: string[]; iterationBudgetUsedPct: number };
    expect(data.status).toBe("healthy");
    expect(data.anomalies).toEqual([]);
    expect(data.iterationBudgetUsedPct).toBe(20);
  });

  it("returns a critical verdict with anomaly codes for a failing loop", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_evaluate_loop_health",
      arguments: { iteration: 5, maxIterations: 5, errored: true, noProgressStreak: 3 },
    });
    const data = result.structuredContent as { status: string; anomalies: string[] };
    expect(data.status).toBe("critical");
    expect(data.anomalies).toEqual(expect.arrayContaining(["errored", "no_progress", "near_iteration_budget"]));
  });
});
