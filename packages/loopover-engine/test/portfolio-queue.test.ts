import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dequeueItem,
  enqueueItem,
  nextEligibleItems,
  type PortfolioQueue,
} from "../dist/index.js";

const item = (id: string, repoFullName: string, state: "queued" | "in_progress" = "queued") => ({
  id,
  repoFullName,
  state,
});

const queueOf = (...items: Array<ReturnType<typeof item>>): PortfolioQueue =>
  items.reduce<PortfolioQueue>((queue, entry) => enqueueItem(queue, entry), { buckets: [] });

test("barrel: the public entrypoint re-exports the portfolio queue primitives", () => {
  assert.equal(typeof enqueueItem, "function");
  assert.equal(typeof dequeueItem, "function");
  assert.equal(typeof nextEligibleItems, "function");
});

test("nextEligibleItems: alternates repos when another eligible bucket exists", () => {
  const queue = queueOf(
    item("a-running", "acme/alpha", "in_progress"),
    item("a-queued-1", "acme/alpha"),
    item("a-queued-2", "acme/alpha"),
    item("b-queued-1", "acme/beta"),
    item("c-queued-1", "acme/gamma"),
  );

  assert.deepEqual(
    nextEligibleItems(queue, { globalWipCap: 4, perRepoWipCap: 2 }).map((entry) => entry.id),
    ["b-queued-1", "c-queued-1", "a-queued-1"],
  );
});

test("nextEligibleItems: repeats a repo only after the others are exhausted", () => {
  const queue = queueOf(
    item("a-queued-1", "acme/alpha"),
    item("a-queued-2", "acme/alpha"),
    item("b-queued-1", "acme/beta"),
  );

  assert.deepEqual(
    nextEligibleItems(queue, { globalWipCap: 3, perRepoWipCap: 3 }).map((entry) => entry.id),
    ["a-queued-1", "b-queued-1", "a-queued-2"],
  );
});
