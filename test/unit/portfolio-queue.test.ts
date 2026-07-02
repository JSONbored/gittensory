import { describe, expect, it } from "vitest";
import {
  dequeueItem,
  enqueueItem,
  nextEligibleItems,
  type PortfolioCaps,
  type PortfolioQueue,
  type PortfolioQueueItem,
} from "../../packages/gittensory-engine/src/portfolio/queue";

function item(
  id: string,
  repoFullName: string,
  state: PortfolioQueueItem["state"] = "queued",
): PortfolioQueueItem {
  return { id, repoFullName, state };
}

function queueOf(...items: PortfolioQueueItem[]): PortfolioQueue {
  return items.reduce<PortfolioQueue>((queue, entry) => enqueueItem(queue, entry), { buckets: [] });
}

describe("portfolio queue primitives", () => {
  it("enqueues by repo bucket, keeps insertion order, and ignores duplicate ids", () => {
    const queue = queueOf(
      item("a-1", "acme/alpha"),
      item("b-1", "acme/beta"),
      item("a-2", "acme/alpha"),
      item("a-1", "acme/gamma"),
    );

    expect(queue).toEqual({
      buckets: [
        { repoFullName: "acme/alpha", items: [item("a-1", "acme/alpha"), item("a-2", "acme/alpha")] },
        { repoFullName: "acme/beta", items: [item("b-1", "acme/beta")] },
      ],
    });
  });

  it("ignores blank ids and blank repo names when enqueuing", () => {
    const queue = queueOf(item("a-1", "acme/alpha"));

    expect(enqueueItem(queue, item("   ", "acme/beta"))).toBe(queue);
    expect(enqueueItem(queue, item("b-1", "   "))).toBe(queue);
  });

  it("dequeues one item and drops an empty repo bucket", () => {
    const queue = queueOf(item("a-1", "acme/alpha"), item("b-1", "acme/beta"));

    expect(dequeueItem(queue, "b-1")).toEqual({
      buckets: [{ repoFullName: "acme/alpha", items: [item("a-1", "acme/alpha")] }],
    });
    expect(dequeueItem(queue, "missing")).toBe(queue);
  });

  it("returns no eligible items for an empty queue", () => {
    expect(nextEligibleItems({ buckets: [] }, { globalWipCap: 2, perRepoWipCap: 1 })).toEqual([]);
  });

  it("returns no eligible items when a single repo is already at its WIP cap", () => {
    const queue = queueOf(
      item("a-running", "acme/alpha", "in_progress"),
      item("a-queued-1", "acme/alpha"),
      item("a-queued-2", "acme/alpha"),
    );

    expect(nextEligibleItems(queue, { globalWipCap: 3, perRepoWipCap: 1 })).toEqual([]);
  });

  it("diversifies multi-repo selection and prefers the least represented repos first", () => {
    const queue = queueOf(
      item("a-running", "acme/alpha", "in_progress"),
      item("a-queued-1", "acme/alpha"),
      item("a-queued-2", "acme/alpha"),
      item("b-queued-1", "acme/beta"),
      item("c-queued-1", "acme/gamma"),
    );
    const caps: PortfolioCaps = { globalWipCap: 4, perRepoWipCap: 2 };

    expect(nextEligibleItems(queue, caps).map((entry) => entry.id)).toEqual([
      "b-queued-1",
      "c-queued-1",
      "a-queued-1",
    ]);
  });

  it("reuses the same repo only after every other eligible repo is exhausted", () => {
    const queue = queueOf(
      item("a-queued-1", "acme/alpha"),
      item("a-queued-2", "acme/alpha"),
      item("b-queued-1", "acme/beta"),
    );

    expect(nextEligibleItems(queue, { globalWipCap: 3, perRepoWipCap: 3 }).map((entry) => entry.id)).toEqual([
      "a-queued-1",
      "b-queued-1",
      "a-queued-2",
    ]);
  });

  it("returns no eligible items when global WIP is already full", () => {
    const queue = queueOf(
      item("a-running", "acme/alpha", "in_progress"),
      item("b-running", "acme/beta", "in_progress"),
      item("a-queued-1", "acme/alpha"),
      item("b-queued-1", "acme/beta"),
    );

    expect(nextEligibleItems(queue, { globalWipCap: 2, perRepoWipCap: 2 })).toEqual([]);
  });
});
