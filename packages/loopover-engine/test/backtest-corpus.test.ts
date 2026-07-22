import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBacktestCorpus, type BacktestCase, type HumanOverrideEvent, type RuleFiredEvent } from "../dist/index.js";

const RULE = "missing_linked_issue";

function fired(targetKey: string, overrides: Partial<RuleFiredEvent> = {}): RuleFiredEvent {
  return { ruleId: RULE, targetKey, outcome: "block", occurredAt: "2026-07-22T00:00:00.000Z", ...overrides };
}

function override(
  targetKey: string,
  verdict: HumanOverrideEvent["verdict"],
  overrides: Partial<HumanOverrideEvent> = {},
): HumanOverrideEvent {
  return { ruleId: RULE, targetKey, verdict, occurredAt: "2026-07-22T01:00:00.000Z", ...overrides };
}

test("barrel: the public entrypoint re-exports buildBacktestCorpus (#8083)", () => {
  assert.equal(typeof buildBacktestCorpus, "function");
});

test("buildBacktestCorpus: a fired event with no matching override is excluded (only decided cases count)", () => {
  const corpus = buildBacktestCorpus(RULE, [fired("a#1"), fired("a#2")], [override("a#1", "confirmed")]);
  assert.equal(corpus.length, 1);
  assert.equal(corpus[0]!.targetKey, "a#1");
});

test("buildBacktestCorpus: a single fired+override pair produces one correctly-labeled case", () => {
  const corpus = buildBacktestCorpus(
    RULE,
    [fired("a#1", { outcome: "block", occurredAt: "2026-07-22T00:00:00.000Z", metadata: { pr: 1 } })],
    [override("a#1", "reversed", { occurredAt: "2026-07-22T02:00:00.000Z" })],
  );
  assert.deepEqual(corpus, [
    {
      ruleId: RULE,
      targetKey: "a#1",
      outcome: "block",
      label: "reversed",
      firedAt: "2026-07-22T00:00:00.000Z",
      decidedAt: "2026-07-22T02:00:00.000Z",
      metadata: { pr: 1 },
    } satisfies BacktestCase,
  ]);
});

test("buildBacktestCorpus: metadata is omitted entirely (not undefined) when the fired event has none", () => {
  const corpus = buildBacktestCorpus(RULE, [fired("a#1")], [override("a#1", "confirmed")]);
  assert.equal("metadata" in corpus[0]!, false);
});

test("buildBacktestCorpus: multiple overrides -> the firing pairs with the nearest override strictly after it", () => {
  const corpus = buildBacktestCorpus(
    RULE,
    [fired("a#1", { occurredAt: "2026-07-22T00:00:00.000Z" })],
    [
      override("a#1", "confirmed", { occurredAt: "2026-07-22T03:00:00.000Z" }),
      override("a#1", "reversed", { occurredAt: "2026-07-22T01:00:00.000Z" }),
      override("a#1", "confirmed", { occurredAt: "2026-07-21T23:00:00.000Z" }),
    ],
  );
  // The 01:00 override is the nearest one strictly after the 00:00 firing -> label "reversed".
  assert.equal(corpus.length, 1);
  assert.equal(corpus[0]!.label, "reversed");
  assert.equal(corpus[0]!.decidedAt, "2026-07-22T01:00:00.000Z");
});

test("buildBacktestCorpus: when no override strictly follows the firing, the most recent override is used", () => {
  const corpus = buildBacktestCorpus(
    RULE,
    [fired("a#1", { occurredAt: "2026-07-22T05:00:00.000Z" })],
    [
      override("a#1", "reversed", { occurredAt: "2026-07-22T02:00:00.000Z" }),
      override("a#1", "confirmed", { occurredAt: "2026-07-22T04:00:00.000Z" }),
    ],
  );
  // Both overrides precede the 05:00 firing -> fall back to the most recent (04:00, "confirmed").
  assert.equal(corpus.length, 1);
  assert.equal(corpus[0]!.label, "confirmed");
  assert.equal(corpus[0]!.decidedAt, "2026-07-22T04:00:00.000Z");
});

test("buildBacktestCorpus: two firings for the same target each yield their own case (no duplicate for one firing)", () => {
  const corpus = buildBacktestCorpus(
    RULE,
    [fired("a#1", { occurredAt: "2026-07-22T00:00:00.000Z" }), fired("a#1", { occurredAt: "2026-07-22T02:30:00.000Z" })],
    [
      override("a#1", "reversed", { occurredAt: "2026-07-22T01:00:00.000Z" }),
      override("a#1", "confirmed", { occurredAt: "2026-07-22T03:00:00.000Z" }),
    ],
  );
  assert.equal(corpus.length, 2);
  assert.deepEqual(corpus.map((c) => c.decidedAt), ["2026-07-22T01:00:00.000Z", "2026-07-22T03:00:00.000Z"]);
});

test("buildBacktestCorpus: fired and override events for a different ruleId are ignored", () => {
  const corpus = buildBacktestCorpus(
    RULE,
    [fired("a#1"), { ruleId: "other_rule", targetKey: "a#1", outcome: "block", occurredAt: "2026-07-22T00:00:00.000Z" }],
    [override("a#1", "confirmed"), { ruleId: "other_rule", targetKey: "a#1", verdict: "reversed", occurredAt: "2026-07-22T01:00:00.000Z" }],
  );
  assert.equal(corpus.length, 1);
  assert.equal(corpus[0]!.ruleId, RULE);
  assert.equal(corpus[0]!.label, "confirmed");
});

test("buildBacktestCorpus: empty input arrays produce an empty corpus", () => {
  assert.deepEqual(buildBacktestCorpus(RULE, [], []), []);
});
