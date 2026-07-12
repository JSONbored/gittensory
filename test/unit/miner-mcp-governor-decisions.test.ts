import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@jsonbored/gittensory-engine", async () => {
  return import("../../packages/gittensory-engine/src/index");
});

import { createMinerMcpServer } from "../../packages/gittensory-miner/bin/gittensory-miner-mcp.js";
import {
  closeDefaultGovernorLedger,
  initGovernorLedger,
} from "../../packages/gittensory-miner/lib/governor-ledger.js";
import {
  collectGovernorLedgerDecisions,
  GOVERNOR_DECISION_ENTRY_FIELDS,
  normalizeGovernorDecisionMcpFilter,
} from "../../packages/gittensory-miner/lib/governor-ledger-cli.js";

type Content = { content: Array<{ type: string; text?: string }>; isError?: boolean };

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-mcp-governor-decisions-"));
  roots.push(root);
  const ledger = initGovernorLedger(join(root, "governor-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  closeDefaultGovernorLedger();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function connectedClient(governorLedger: ReturnType<typeof initGovernorLedger>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "miner-mcp-governor-decisions-test", version: "0.0.0" });
  await Promise.all([
    createMinerMcpServer({ initGovernorLedger: () => governorLedger }).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

function toolText(result: Content): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected a single text content block");
  }
  return first.text;
}

// Seeds two acme/widgets rows (allowed, denied) and one acme/other row. Every payload carries a would-be-secret
// blob plus the exact field names #5134 is adding to payload_json (reputation / self_plagiarism / budget), so a
// leak of any of them through the projection is caught by the invariant tests below.
function seedDecisions(governorLedger: ReturnType<typeof initGovernorLedger>) {
  governorLedger.appendGovernorEvent({
    eventType: "allowed",
    repoFullName: "acme/widgets",
    actionClass: "analyze",
    decision: "allow",
    reason: "within budget",
    payload: { rule: "budget_ok", secretBlob: "must-not-leak" },
  });
  governorLedger.appendGovernorEvent({
    eventType: "denied",
    repoFullName: "acme/widgets",
    actionClass: "write",
    decision: "block",
    reason: "kill switch active",
    payload: { rule: "global_kill_switch", reputation: 0.1, budget: 5, self_plagiarism: true },
  });
  governorLedger.appendGovernorEvent({
    eventType: "denied",
    repoFullName: "acme/other",
    actionClass: "write",
    decision: "block",
    reason: "other repo",
    payload: { rule: "house_rule" },
  });
}

describe("governor ledger decision projection (#5159)", () => {
  it("readGovernorDecisions returns the six decision columns only and never the payload (by construction)", () => {
    const ledger = tempLedger();
    seedDecisions(ledger);
    const decisions = ledger.readGovernorDecisions();
    expect(decisions).toEqual([
      {
        ts: expect.any(String),
        eventType: "allowed",
        repoFullName: "acme/widgets",
        actionClass: "analyze",
        decision: "allow",
        reason: "within budget",
      },
      {
        ts: expect.any(String),
        eventType: "denied",
        repoFullName: "acme/widgets",
        actionClass: "write",
        decision: "block",
        reason: "kill switch active",
      },
      {
        ts: expect.any(String),
        eventType: "denied",
        repoFullName: "acme/other",
        actionClass: "write",
        decision: "block",
        reason: "other repo",
      },
    ]);
    for (const decision of decisions) {
      expect(Object.keys(decision).sort()).toEqual([...GOVERNOR_DECISION_ENTRY_FIELDS].sort());
      expect(JSON.stringify(decision)).not.toContain("payload");
      expect(JSON.stringify(decision)).not.toContain("must-not-leak");
    }
  });

  it("readGovernorDecisions filters by repo via the explicit-column SELECT (repo branch)", () => {
    const ledger = tempLedger();
    seedDecisions(ledger);
    expect(ledger.readGovernorDecisions({ repoFullName: "acme/other" }).map((d) => d.reason)).toEqual([
      "other repo",
    ]);
  });

  it("readGovernorDecisions returns an empty array before any append", () => {
    const ledger = tempLedger();
    expect(ledger.readGovernorDecisions({ repoFullName: "acme/widgets" })).toEqual([]);
  });
});

describe("normalizeGovernorDecisionMcpFilter (#5159)", () => {
  it("defaults to null filters when no input is given", () => {
    expect(normalizeGovernorDecisionMcpFilter()).toEqual({ repoFullName: null, type: null });
  });

  it("mirrors governor list repo + type filter semantics", () => {
    expect(normalizeGovernorDecisionMcpFilter({ repoFullName: "acme/widgets", type: "denied" })).toEqual({
      repoFullName: "acme/widgets",
      type: "denied",
    });
  });

  it("treats explicit null repo/type as unset", () => {
    expect(normalizeGovernorDecisionMcpFilter({ repoFullName: null, type: null })).toEqual({
      repoFullName: null,
      type: null,
    });
  });

  it("rejects a non-object filter, a bad repo, and an unknown event type", () => {
    expect(() =>
      normalizeGovernorDecisionMcpFilter(null as unknown as Record<string, unknown>),
    ).toThrow("filter must be an object");
    expect(() =>
      normalizeGovernorDecisionMcpFilter(42 as unknown as Record<string, unknown>),
    ).toThrow("filter must be an object");
    expect(() =>
      normalizeGovernorDecisionMcpFilter([] as unknown as Record<string, unknown>),
    ).toThrow("filter must be an object");
    expect(() => normalizeGovernorDecisionMcpFilter({ repoFullName: "bad" })).toThrow(
      "Repository must be in owner/repo form.",
    );
    expect(() => normalizeGovernorDecisionMcpFilter({ type: "bogus" })).toThrow(/Invalid type/);
  });
});

describe("collectGovernorLedgerDecisions (#5159)", () => {
  it("wraps decisions without a repoFullName key when no repo filter is set (default filter)", () => {
    const ledger = tempLedger();
    seedDecisions(ledger);
    const feed = collectGovernorLedgerDecisions(ledger);
    expect(feed).not.toHaveProperty("repoFullName");
    expect(feed.decisions.map((d) => d.eventType)).toEqual(["allowed", "denied", "denied"]);
  });

  it("includes the repoFullName key and applies the type filter when both are set", () => {
    const ledger = tempLedger();
    seedDecisions(ledger);
    const feed = collectGovernorLedgerDecisions(ledger, { repoFullName: "acme/widgets", type: "denied" });
    expect(feed.repoFullName).toBe("acme/widgets");
    expect(feed.decisions.map((d) => d.reason)).toEqual(["kill switch active"]);
  });
});

describe("gittensory_miner_get_governor_decisions (#5159)", () => {
  it("is registered on the miner MCP server", async () => {
    const ledger = tempLedger();
    const client = await connectedClient(ledger);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("gittensory_miner_get_governor_decisions");
  });

  it("returns decision-log rows with repo + type filters", async () => {
    const ledger = tempLedger();
    seedDecisions(ledger);
    const client = await connectedClient(ledger);
    const result = (await client.callTool({
      name: "gittensory_miner_get_governor_decisions",
      arguments: { repoFullName: "acme/widgets", type: "denied" },
    })) as Content;
    const payload = JSON.parse(toolText(result));
    expect(payload.repoFullName).toBe("acme/widgets");
    expect(payload.decisions).toEqual([
      {
        ts: expect.any(String),
        eventType: "denied",
        repoFullName: "acme/widgets",
        actionClass: "write",
        decision: "block",
        reason: "kill switch active",
      },
    ]);
  });

  it("returns an empty decisions array for an empty ledger", async () => {
    const ledger = tempLedger();
    const client = await connectedClient(ledger);
    const result = (await client.callTool({
      name: "gittensory_miner_get_governor_decisions",
      arguments: {},
    })) as Content;
    expect(JSON.parse(toolText(result))).toEqual({ decisions: [] });
  });

  it("is structurally identical to collectGovernorLedgerDecisions() — the wrapper adds no drift (invariant)", async () => {
    const ledger = tempLedger();
    seedDecisions(ledger);
    const filter = normalizeGovernorDecisionMcpFilter({ repoFullName: "acme/widgets" });
    const client = await connectedClient(ledger);
    const result = (await client.callTool({
      name: "gittensory_miner_get_governor_decisions",
      arguments: { repoFullName: "acme/widgets" },
    })) as Content;
    expect(JSON.parse(toolText(result))).toEqual(collectGovernorLedgerDecisions(ledger, filter));
  });

  it("never exposes payload_json or the #5134 payload fields (reputation / self-plagiarism / budget) (invariant)", async () => {
    const ledger = tempLedger();
    seedDecisions(ledger);
    const client = await connectedClient(ledger);
    const result = (await client.callTool({
      name: "gittensory_miner_get_governor_decisions",
      arguments: {},
    })) as Content;
    const payload = JSON.parse(toolText(result));
    for (const decision of payload.decisions) {
      expect(Object.keys(decision).sort()).toEqual([...GOVERNOR_DECISION_ENTRY_FIELDS].sort());
      for (const banned of [
        "payload_json",
        "payload",
        "reputation",
        "selfPlagiarism",
        "self_plagiarism",
        "budget",
      ]) {
        expect(decision).not.toHaveProperty(banned);
      }
    }
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("self_plagiarism");
    expect(serialized).not.toContain("reputation");
  });

  it("only reads — never reaches a mutating governor-ledger method (invariant)", async () => {
    const ledger = tempLedger();
    seedDecisions(ledger);
    const readGovernorDecisions = vi.spyOn(ledger, "readGovernorDecisions");
    const appendGovernorEvent = vi.spyOn(ledger, "appendGovernorEvent");
    const client = await connectedClient(ledger);
    await client.callTool({
      name: "gittensory_miner_get_governor_decisions",
      arguments: { type: "denied" },
    });
    expect(readGovernorDecisions).toHaveBeenCalled();
    expect(appendGovernorEvent).not.toHaveBeenCalled();
  });

  it("returns an MCP error for an unknown event type", async () => {
    const ledger = tempLedger();
    const client = await connectedClient(ledger);
    const result = (await client.callTool({
      name: "gittensory_miner_get_governor_decisions",
      arguments: { type: "bogus" },
    })) as Content;
    expect(result.isError).toBe(true);
    expect(toolText(result)).toMatch(/Invalid type/i);
  });
});
