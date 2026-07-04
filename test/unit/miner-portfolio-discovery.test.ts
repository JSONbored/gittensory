import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeDefaultEventLedger,
  initEventLedger,
} from "../../packages/gittensory-miner/lib/event-ledger.js";
import { enqueueRankedDiscovery } from "../../packages/gittensory-miner/lib/portfolio-discovery.js";
import {
  closeDefaultPortfolioQueueStore,
  initPortfolioQueueStore,
} from "../../packages/gittensory-miner/lib/portfolio-queue.js";

const roots: string[] = [];
const stores: Array<{ close(): void }> = [];

function tempQueueStore() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-discovery-"));
  roots.push(root);
  const store = initPortfolioQueueStore(join(root, "portfolio-queue.sqlite3"));
  stores.push(store);
  return store;
}

function tempEventLedger() {
  const root = mkdtempSync(join(tmpdir(), "gittensory-miner-portfolio-discovery-ledger-"));
  roots.push(root);
  const ledger = initEventLedger(join(root, "event-ledger.sqlite3"));
  stores.push(ledger);
  return ledger;
}

function rankedIssue(overrides: Record<string, unknown> = {}) {
  return {
    owner: "acme",
    repo: "widgets",
    repoFullName: "acme/widgets",
    issueNumber: 42,
    title: "Add queue retry helper",
    labels: ["help wanted"],
    commentsCount: 1,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
    htmlUrl: "https://github.com/acme/widgets/issues/42",
    aiPolicyAllowed: true,
    aiPolicySource: "CONTRIBUTING.md",
    potential: 0.8,
    feasibility: 0.7,
    laneFit: 0.6,
    freshness: 0.5,
    dupRisk: 0.1,
    rankScore: 50,
    ...overrides,
  };
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  closeDefaultPortfolioQueueStore();
  closeDefaultEventLedger();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("gittensory-miner portfolio discovery (#2292)", () => {
  it("returns a zero summary for empty input without touching the queue", () => {
    const queueStore = tempQueueStore();
    expect(enqueueRankedDiscovery([], { queueStore })).toEqual({
      enqueued: 0,
      skippedBelowMinRank: 0,
      skippedInvalid: 0,
      eventsAppended: 0,
    });
    expect(queueStore.listQueue()).toEqual([]);
  });

  it("enqueues ranked rows using rankScore as portfolio priority", () => {
    const queueStore = tempQueueStore();
    const summary = enqueueRankedDiscovery(
      [
        rankedIssue({ issueNumber: 1, rankScore: 10 }),
        rankedIssue({ issueNumber: 2, rankScore: 90 }),
        rankedIssue({ issueNumber: 3, rankScore: 40 }),
      ],
      { queueStore },
    );
    expect(summary).toEqual({
      enqueued: 3,
      skippedBelowMinRank: 0,
      skippedInvalid: 0,
      eventsAppended: 0,
    });
    expect(queueStore.dequeueNext()?.identifier).toBe("issue:2");
    expect(queueStore.dequeueNext()?.identifier).toBe("issue:3");
    expect(queueStore.dequeueNext()?.identifier).toBe("issue:1");
  });

  it("skips rows below minRankScore without enqueueing them", () => {
    const queueStore = tempQueueStore();
    const summary = enqueueRankedDiscovery(
      [
        rankedIssue({ issueNumber: 1, rankScore: 5 }),
        rankedIssue({ issueNumber: 2, rankScore: 25 }),
      ],
      { queueStore, minRankScore: 20 },
    );
    expect(summary).toEqual({
      enqueued: 1,
      skippedBelowMinRank: 1,
      skippedInvalid: 0,
      eventsAppended: 0,
    });
    expect(queueStore.listQueue().map((entry) => entry.identifier)).toEqual(["issue:2"]);
  });

  it("skips malformed ranked rows instead of throwing", () => {
    const queueStore = tempQueueStore();
    const summary = enqueueRankedDiscovery(
      [
        rankedIssue({ issueNumber: 1, rankScore: 30 }),
        { repoFullName: "bad", issueNumber: 2, title: "x", rankScore: 40 },
        rankedIssue({ issueNumber: 3, title: "", rankScore: 50 }),
      ],
      { queueStore },
    );
    expect(summary).toEqual({
      enqueued: 1,
      skippedBelowMinRank: 0,
      skippedInvalid: 2,
      eventsAppended: 0,
    });
    expect(queueStore.listQueue()[0]?.identifier).toBe("issue:1");
  });

  it("refreshes priority for done items but leaves in_progress rows unchanged", () => {
    const queueStore = tempQueueStore();
    enqueueRankedDiscovery([rankedIssue({ issueNumber: 7, rankScore: 10 })], { queueStore });
    expect(queueStore.dequeueNext()).toMatchObject({ identifier: "issue:7", status: "in_progress", priority: 10 });

    enqueueRankedDiscovery([rankedIssue({ issueNumber: 8, rankScore: 5 })], { queueStore });
    queueStore.markDone("acme/widgets", "issue:8");

    enqueueRankedDiscovery(
      [
        rankedIssue({ issueNumber: 7, rankScore: 99 }),
        rankedIssue({ issueNumber: 8, rankScore: 88 }),
      ],
      { queueStore },
    );

    expect(queueStore.listQueue("acme/widgets").find((entry) => entry.identifier === "issue:7")).toMatchObject({
      status: "in_progress",
      priority: 10,
    });
    expect(queueStore.listQueue("acme/widgets").find((entry) => entry.identifier === "issue:8")).toMatchObject({
      status: "queued",
      priority: 88,
    });
  });

  it("appends discovered_issue audit events when an event ledger is supplied", () => {
    const queueStore = tempQueueStore();
    const eventLedger = tempEventLedger();
    const summary = enqueueRankedDiscovery([rankedIssue({ issueNumber: 12, rankScore: 33 })], {
      queueStore,
      eventLedger,
    });
    expect(summary.eventsAppended).toBe(1);
    expect(eventLedger.readEvents()).toEqual([
      expect.objectContaining({
        seq: 1,
        type: "discovered_issue",
        repoFullName: "acme/widgets",
        payload: {
          issueNumber: 12,
          rankScore: 33,
          title: "Add queue retry helper",
          labels: ["help wanted"],
        },
      }),
    ]);
  });

  it("rejects an invalid queue store or minRankScore", () => {
    expect(() => enqueueRankedDiscovery([], { queueStore: null as never })).toThrow("invalid_queue_store");
    expect(() =>
      enqueueRankedDiscovery([], { queueStore: tempQueueStore(), minRankScore: Number.NaN }),
    ).toThrow("invalid_min_rank_score");
  });
});
