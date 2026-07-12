import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initEventLedger } from "../../packages/gittensory-miner/lib/event-ledger.js";
import {
  runLedgerCli,
  runLedgerScrape,
} from "../../packages/gittensory-miner/lib/event-ledger-cli.js";
import { renderEventLedgerMetrics } from "../../packages/gittensory-miner/lib/event-ledger-metrics.js";

const roots: string[] = [];
const ledgers: Array<{ close(): void }> = [];

function tempLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-event-scrape-"));
  roots.push(root);
  const ledger = initEventLedger(join(root, "event-ledger.sqlite3"));
  ledgers.push(ledger);
  return ledger;
}

function captureStdout(): { text: () => string } {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join("") };
}

afterEach(() => {
  for (const ledger of ledgers.splice(0)) ledger.close();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("renderEventLedgerMetrics (#4841)", () => {
  it("counts events by type as sorted Prometheus counters", () => {
    const text = renderEventLedgerMetrics([
      { type: "manage_pr_update" },
      { type: "discovered_issue" },
      { type: "manage_pr_update" },
    ]);
    expect(text).toContain("# HELP gittensory_miner_events_total");
    expect(text).toContain("# TYPE gittensory_miner_events_total counter");
    const body = text.split("\n");
    // sorted by type: discovered_issue before manage_pr_update
    const discoveredIdx = body.findIndex((l) => l.includes('type="discovered_issue"'));
    const manageIdx = body.findIndex((l) => l.includes('type="manage_pr_update"'));
    expect(discoveredIdx).toBeGreaterThan(-1);
    expect(discoveredIdx).toBeLessThan(manageIdx);
    expect(text).toContain('gittensory_miner_events_total{type="discovered_issue"} 1');
    expect(text).toContain('gittensory_miner_events_total{type="manage_pr_update"} 2');
    expect(text.endsWith("\n")).toBe(true);
  });

  it("emits a well-formed empty surface (HELP/TYPE only) with no events", () => {
    const text = renderEventLedgerMetrics([]);
    expect(text).toContain("# TYPE gittensory_miner_events_total counter");
    expect(text).not.toContain('gittensory_miner_events_total{');
  });

  it("escapes special characters in an event type label", () => {
    const text = renderEventLedgerMetrics([{ type: 'we"ird\\type' }]);
    expect(text).toContain('gittensory_miner_events_total{type="we\\"ird\\\\type"} 1');
  });
});

describe("gittensory-miner ledger scrape (#4841)", () => {
  it("prints the event-ledger Prometheus surface to stdout", () => {
    const eventLedger = tempLedger();
    eventLedger.appendEvent({ type: "discovered_issue", repoFullName: "acme/widgets", payload: { issueNumber: 1 } });
    eventLedger.appendEvent({ type: "manage_pr_update", repoFullName: "acme/widgets", payload: { prNumber: 2 } });
    const out = captureStdout();

    expect(runLedgerScrape([], { initEventLedger: () => eventLedger })).toBe(0);
    const text = out.text();
    expect(text).toContain('gittensory_miner_events_total{type="discovered_issue"} 1');
    expect(text).toContain('gittensory_miner_events_total{type="manage_pr_update"} 1');
  });

  it("is reachable through the ledger subcommand dispatcher", () => {
    const eventLedger = tempLedger();
    eventLedger.appendEvent({ type: "plan_built", payload: { steps: 1 } });
    const out = captureStdout();

    expect(runLedgerCli("scrape", [], { initEventLedger: () => eventLedger })).toBe(0);
    expect(out.text()).toContain('gittensory_miner_events_total{type="plan_built"} 1');
  });

  it("rejects an unknown option with exit code 2", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(runLedgerScrape(["--bogus"], { initEventLedger: () => tempLedger() })).toBe(2);
    expect(String(err.mock.calls[0]?.[0])).toContain("Unknown option");
  });

  it("surfaces a store failure (Error) as exit code 2", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boom = () => {
      throw new Error("store unavailable");
    };
    expect(runLedgerScrape([], { initEventLedger: boom })).toBe(2);
    expect(String(err.mock.calls[0]?.[0])).toContain("store unavailable");
  });

  it("surfaces a non-Error store failure as exit code 2", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const boom = () => {
      throw "raw failure string"; // non-Error throw ⇒ String(error) branch
    };
    expect(runLedgerScrape([], { initEventLedger: boom })).toBe(2);
    expect(String(err.mock.calls[0]?.[0])).toContain("raw failure string");
  });
});
