import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MINER_PR_OUTCOME_EVENT } from "../../packages/gittensory-miner/lib/pr-outcome.js";
import {
  bucketReasonCode,
  exportMinerOrbBatch,
  getOrCreateAnonSecret,
  initOrbExportStateStore,
  isMinerOrbExportEnabled,
  ledgerEntryToFleetEvent,
  readLastExportedSeq,
  selectPrOutcomeEvents,
  writeLastExportedSeq,
} from "../../packages/gittensory-miner/lib/orb-export.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function tempStateStore() {
  const dir = mkdtempSync(join(tmpdir(), "miner-orb-export-"));
  tempDirs.push(dir);
  return initOrbExportStateStore(join(dir, "orb-export-state.sqlite3"));
}

function mockLedger() {
  const events: Array<Record<string, unknown>> = [];
  let seq = 0;
  return {
    append(type: string, repoFullName: string, payload: Record<string, unknown>, createdAt?: string) {
      const entry = {
        seq: ++seq,
        type,
        repoFullName,
        payload,
        createdAt: createdAt ?? "2026-07-09T12:00:00.000Z",
      };
      events.push(entry);
      return entry;
    },
    readEvents(filter: { since?: number; repoFullName?: string } = {}) {
      return events.filter((event) => {
        if (filter.repoFullName !== undefined && event.repoFullName !== filter.repoFullName) return false;
        if (filter.since !== undefined && (event.seq as number) <= filter.since) return false;
        return true;
      });
    },
    _events: events,
  };
}

describe("bucketReasonCode() (#4277)", () => {
  it("shares the self-host orb-collector taxonomy", () => {
    expect(bucketReasonCode(null)).toBe("none");
    expect(bucketReasonCode("superseded_by_duplicate")).toBe("duplicate_risk");
    expect(bucketReasonCode("missing_linked_issue")).toBe("issue_policy");
    expect(bucketReasonCode("gate_close")).toBe("other");
  });
});

describe("isMinerOrbExportEnabled() (#4277)", () => {
  it("defaults OFF unless explicitly enabled and not air-gapped", () => {
    expect(isMinerOrbExportEnabled({}, {})).toBe(false);
    expect(isMinerOrbExportEnabled({ GITTENSORY_MINER_ORB_EXPORT: "1" }, {})).toBe(true);
    expect(isMinerOrbExportEnabled({}, { orbExport: true })).toBe(true);
    expect(isMinerOrbExportEnabled({ GITTENSORY_MINER_ORB_EXPORT: "1", ORB_AIR_GAP: "true" }, {})).toBe(false);
  });
});

describe("getOrCreateAnonSecret() (#4277)", () => {
  it("generates a dedicated 256-bit secret once and reuses it", () => {
    const store = tempStateStore();
    const first = getOrCreateAnonSecret(store);
    const second = getOrCreateAnonSecret(store);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });
});

describe("ledgerEntryToFleetEvent() (#4277)", () => {
  it("HMACs repo/PR identifiers and buckets the rejection reason", () => {
    const store = tempStateStore();
    const secret = getOrCreateAnonSecret(store);
    const event = ledgerEntryToFleetEvent(
      {
        seq: 1,
        type: MINER_PR_OUTCOME_EVENT,
        repoFullName: "acme/widgets",
        payload: { prNumber: 12, decision: "closed", reason: "superseded_by_duplicate", closedAt: "2026-07-09T00:00:00Z" },
        createdAt: "2026-07-09T12:00:00.000Z",
      },
      { secret, anonymize: true },
    );
    expect(event?.repo_hash).not.toBe("acme/widgets");
    expect(event?.pr_hash).not.toBe("acme/widgets#12");
    expect(event?.gate_reasoncode_bucket).toBe("duplicate_risk");
    expect(event?.outcome).toBe("closed");
    expect(event?.gate_verdict).toBeNull();
  });

  it("can emit plaintext identifiers when anonymize is disabled", () => {
    const store = tempStateStore();
    const secret = getOrCreateAnonSecret(store);
    const event = ledgerEntryToFleetEvent(
      {
        seq: 1,
        type: MINER_PR_OUTCOME_EVENT,
        repoFullName: "acme/widgets",
        payload: { prNumber: 12, decision: "merged" },
      },
      { secret, anonymize: false },
    );
    expect(event?.repo_hash).toBe("acme/widgets");
    expect(event?.pr_hash).toBe("acme/widgets#12");
  });
});

describe("selectPrOutcomeEvents() (#4277)", () => {
  it("returns only pr_outcome rows strictly after since, in seq order", () => {
    const ledger = mockLedger();
    ledger.append("plan_built", "acme/widgets", { step: 1 });
    ledger.append(MINER_PR_OUTCOME_EVENT, "acme/widgets", { prNumber: 1, decision: "merged" });
    ledger.append(MINER_PR_OUTCOME_EVENT, "acme/a", { prNumber: 2, decision: "closed", reason: "gate_close" });
    expect(selectPrOutcomeEvents(ledger, 0, 10)).toHaveLength(2);
    expect(selectPrOutcomeEvents(ledger, 2, 10)).toHaveLength(1);
    expect(selectPrOutcomeEvents(ledger, 3, 10)).toHaveLength(0);
  });
});

describe("exportMinerOrbBatch() (#4277)", () => {
  it("is a no-op when export is disabled", async () => {
    const ledger = mockLedger();
    ledger.append(MINER_PR_OUTCOME_EVENT, "acme/widgets", { prNumber: 1, decision: "merged" });
    let called = false;
    const n = await exportMinerOrbBatch({
      env: {},
      eventLedger: ledger,
      stateStore: tempStateStore(),
      fetchFn: async () => {
        called = true;
        return new Response(null, { status: 200 });
      },
    });
    expect(n).toBe(0);
    expect(called).toBe(false);
  });

  it("respects ORB_AIR_GAP even when opt-in is set", async () => {
    const ledger = mockLedger();
    ledger.append(MINER_PR_OUTCOME_EVENT, "acme/widgets", { prNumber: 1, decision: "merged" });
    let called = false;
    const n = await exportMinerOrbBatch({
      env: { GITTENSORY_MINER_ORB_EXPORT: "1", ORB_AIR_GAP: "true" },
      eventLedger: ledger,
      stateStore: tempStateStore(),
      fetchFn: async () => {
        called = true;
        return new Response(null, { status: 200 });
      },
    });
    expect(n).toBe(0);
    expect(called).toBe(false);
  });

  it("ships anonymized payloads and advances the seq cursor on success", async () => {
    const ledger = mockLedger();
    ledger.append(MINER_PR_OUTCOME_EVENT, "acme/widgets", { prNumber: 1, decision: "merged" });
    ledger.append(MINER_PR_OUTCOME_EVENT, "acme/widgets", { prNumber: 2, decision: "closed", reason: "gate_close" });
    const stateStore = tempStateStore();
    const bodies: unknown[] = [];

    expect(await exportMinerOrbBatch({
      env: { GITTENSORY_MINER_ORB_EXPORT: "1" },
      eventLedger: ledger,
      stateStore,
      batchSize: 1,
      fetchFn: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 200 });
      },
    })).toBe(1);

    expect(readLastExportedSeq(stateStore)).toBe(1);
    const firstPayload = bodies[0] as { events: Array<{ repo_hash: string; pr_hash: string }> };
    expect(firstPayload.events[0]?.repo_hash).not.toBe("acme/widgets");
    expect(firstPayload.events[0]?.pr_hash).not.toContain("acme/widgets");

    expect(await exportMinerOrbBatch({
      env: { GITTENSORY_MINER_ORB_EXPORT: "1" },
      eventLedger: ledger,
      stateStore,
      batchSize: 1,
      fetchFn: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 200 });
      },
    })).toBe(1);

    expect(readLastExportedSeq(stateStore)).toBe(2);
    expect(bodies).toHaveLength(2);

    expect(await exportMinerOrbBatch({
      env: { GITTENSORY_MINER_ORB_EXPORT: "1" },
      eventLedger: ledger,
      stateStore,
      fetchFn: async () => new Response(null, { status: 200 }),
    })).toBe(0);
  });

  it("does not advance the cursor when the collector rejects the batch", async () => {
    const ledger = mockLedger();
    ledger.append(MINER_PR_OUTCOME_EVENT, "acme/widgets", { prNumber: 1, decision: "merged" });
    const stateStore = tempStateStore();
    writeLastExportedSeq(stateStore, 0);

    expect(await exportMinerOrbBatch({
      env: { GITTENSORY_MINER_ORB_EXPORT: "1" },
      eventLedger: ledger,
      stateStore,
      fetchFn: async () => new Response(null, { status: 503 }),
    })).toBe(0);
    expect(readLastExportedSeq(stateStore)).toBe(0);
  });

  it("throws when the injected event ledger is unusable", async () => {
    await expect(exportMinerOrbBatch({
      env: { GITTENSORY_MINER_ORB_EXPORT: "1" },
      stateStore: tempStateStore(),
    })).rejects.toThrow("invalid_event_ledger");
  });
});
