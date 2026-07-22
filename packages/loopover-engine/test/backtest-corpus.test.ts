import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBacktestCorpus, type BacktestCase, type HumanOverrideEvent, type RuleFiredEvent } from "../dist/index.js";

function fired(ruleId: string, targetKey: string, overrides: Partial<RuleFiredEvent> = {}): RuleFiredEvent {
  return { ruleId, targetKey, outcome: "block", occurredAt: "2026-07-22T00:00:00.000Z", ...overrides };
}

function override(
  ruleId: string,
  targetKey: string,
  verdict: HumanOverrideEvent["verdict"],
  overrides: Partial<HumanOverrideEvent> = {},
): HumanOverrideEvent {
  return { ruleId, targetKey, verdict, occurredAt: "2026-07-22T00:00:00.000Z", ...overrides };
}

test("barrel: the public entrypoint re-exports buildBacktestCorpus (#8083)", () => {
  assert.equal(typeof buildBacktestCorpus, "function");
});

test("buildBacktestCorpus: empty inputs produce an empty corpus", () => {
  assert.deepEqual(buildBacktestCorpus("missing_linked_issue", [], []), []);
});

test("buildBacktestCorpus: a fired event with no matching override is excluded (undecided is not unlabeled)", () => {
  const corpus = buildBacktestCorpus(
    "missing_linked_issue",
    [fired("missing_linked_issue", "a#1"), fired("missing_linked_issue", "a#2")],
    [override("missing_linked_issue", "a#1", "confirmed", { occurredAt: "2026-07-22T01:00:00.000Z" })],
  );
  assert.deepEqual(corpus, [
    {
      ruleId: "missing_linked_issue",
      targetKey: "a#1",
      outcome: "block",
      label: "confirmed",
      firedAt: "2026-07-22T00:00:00.000Z",
      decidedAt: "2026-07-22T01:00:00.000Z",
    },
  ]);
});

test("buildBacktestCorpus: a single fired+override pair yields one correctly-labeled case", () => {
  const corpus = buildBacktestCorpus(
    "missing_linked_issue",
    [fired("missing_linked_issue", "a#7", { outcome: "exclude", occurredAt: "2026-07-22T00:00:00.000Z" })],
    [override("missing_linked_issue", "a#7", "reversed", { occurredAt: "2026-07-22T02:00:00.000Z" })],
  );
  assert.equal(corpus.length, 1);
  assert.equal(corpus[0]!.label, "reversed");
  assert.equal(corpus[0]!.outcome, "exclude");
  assert.equal(corpus[0]!.decidedAt, "2026-07-22T02:00:00.000Z");
});

test("buildBacktestCorpus: metadata rides along when present and is omitted entirely (not undefined) when absent", () => {
  const withMeta = buildBacktestCorpus(
    "r",
    [fired("r", "a#1", { metadata: { source: "orb" } })],
    [override("r", "a#1", "confirmed", { occurredAt: "2026-07-22T01:00:00.000Z" })],
  );
  assert.deepEqual(withMeta[0]!.metadata, { source: "orb" });

  const withoutMeta: BacktestCase = buildBacktestCorpus(
    "r",
    [fired("r", "a#1")],
    [override("r", "a#1", "confirmed", { occurredAt: "2026-07-22T01:00:00.000Z" })],
  )[0]!;
  assert.equal("metadata" in withoutMeta, false);
});

test("buildBacktestCorpus: events for a different ruleId are ignored on both sides", () => {
  const corpus = buildBacktestCorpus(
    "wanted",
    [fired("wanted", "a#1"), fired("other", "a#1")],
    [
      override("wanted", "a#1", "confirmed", { occurredAt: "2026-07-22T01:00:00.000Z" }),
      override("other", "a#1", "reversed", { occurredAt: "2026-07-22T01:00:00.000Z" }),
    ],
  );
  assert.equal(corpus.length, 1);
  assert.equal(corpus[0]!.ruleId, "wanted");
  assert.equal(corpus[0]!.label, "confirmed");
});

test("buildBacktestCorpus: with multiple overrides, pairs the nearest override strictly AFTER the fire", () => {
  const corpus = buildBacktestCorpus(
    "r",
    [fired("r", "a#1", { occurredAt: "2026-07-22T12:00:00.000Z" })],
    [
      override("r", "a#1", "reversed", { occurredAt: "2026-07-22T10:00:00.000Z" }), // before the fire
      override("r", "a#1", "confirmed", { occurredAt: "2026-07-22T13:00:00.000Z" }), // nearest after -> chosen
      override("r", "a#1", "reversed", { occurredAt: "2026-07-22T18:00:00.000Z" }), // later after
    ],
  );
  assert.equal(corpus.length, 1);
  assert.equal(corpus[0]!.label, "confirmed");
  assert.equal(corpus[0]!.decidedAt, "2026-07-22T13:00:00.000Z");
});

test("buildBacktestCorpus: when no override strictly follows the fire, falls back to the most recent override", () => {
  const corpus = buildBacktestCorpus(
    "r",
    [fired("r", "a#1", { occurredAt: "2026-07-22T20:00:00.000Z" })],
    [
      override("r", "a#1", "reversed", { occurredAt: "2026-07-22T10:00:00.000Z" }),
      override("r", "a#1", "confirmed", { occurredAt: "2026-07-22T15:00:00.000Z" }), // most recent, still before -> chosen
    ],
  );
  assert.equal(corpus.length, 1);
  assert.equal(corpus[0]!.label, "confirmed");
  assert.equal(corpus[0]!.decidedAt, "2026-07-22T15:00:00.000Z");
});
