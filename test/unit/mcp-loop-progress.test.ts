import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { LoopoverMcp } from "../../src/mcp/server";
import { createTestEnv } from "../helpers/d1";

async function connect() {
  const server = new LoopoverMcp(createTestEnv()).createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "gittensory-progress-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("MCP loopover_build_progress_snapshot", () => {
  it("builds a progress snapshot for a running loop", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_build_progress_snapshot",
      arguments: {
        iteration: 2, maxIterations: 5, phase: "coding", status: "running",
        recentActivity: [{ step: "claimed issue-1" }, { step: "editing src/upload.ts" }],
      },
    });
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { phase: string; status: string; iteration: number; percentComplete: number; done: boolean; recentActivity: unknown[] };
    expect(data).toMatchObject({ phase: "coding", status: "running", iteration: 2, percentComplete: 40, done: false });
    expect(data.recentActivity).toHaveLength(2);
  });

  it("marks a finished loop done", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "loopover_build_progress_snapshot",
      arguments: { iteration: 3, phase: "done", status: "converged" },
    });
    const data = result.structuredContent as { done: boolean; percentComplete: number | null };
    expect(data.done).toBe(true);
    expect(data.percentComplete).toBeNull(); // no maxIterations given
  });
});
