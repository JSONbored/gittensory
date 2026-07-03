import { test } from "node:test";
import assert from "node:assert/strict";

import { computeOpportunityFreshness } from "../dist/opportunity-freshness.js";

const nowMs = Date.parse("2026-07-03T00:00:00.000Z");

test("computeOpportunityFreshness returns 0 when no open issues exist", () => {
  assert.equal(computeOpportunityFreshness([], nowMs), 0);
  assert.equal(
    computeOpportunityFreshness([{ state: "closed", updatedAt: "2026-07-01T00:00:00.000Z" }], nowMs),
    0,
  );
});

test("computeOpportunityFreshness decays with issue age", () => {
  const fresh = computeOpportunityFreshness(
    [{ state: "open", updatedAt: "2026-07-01T00:00:00.000Z" }],
    nowMs,
  );
  assert.ok(fresh > 0.7);

  const stale = computeOpportunityFreshness(
    [{ state: "open", createdAt: "2023-01-01T00:00:00.000Z" }],
    nowMs,
  );
  assert.ok(stale <= 0.05);
});

test("computeOpportunityFreshness uses the most recently updated open issue", () => {
  const score = computeOpportunityFreshness(
    [
      { state: "open", updatedAt: "2023-01-01T00:00:00.000Z" },
      { state: "open", updatedAt: "2026-07-01T00:00:00.000Z" },
    ],
    nowMs,
  );
  assert.ok(score > 0.7);
});

test("computeOpportunityFreshness treats malformed timestamps as fresh", () => {
  assert.ok(
    computeOpportunityFreshness([{ state: "open", updatedAt: "not-a-date" }], nowMs) > 0.9,
  );
});
