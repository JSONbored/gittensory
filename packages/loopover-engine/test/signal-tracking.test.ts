import assert from "node:assert/strict";
import { test } from "node:test";

import { computeRulePrecision, computeRuleRepeatCount, type HumanOverrideEvent, type RuleFiredEvent } from "../dist/index.js";

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

test("barrel: the public entrypoint re-exports the signal-tracking primitives (#7982)", () => {
  assert.equal(typeof computeRulePrecision, "function");
  assert.equal(typeof computeRuleRepeatCount, "function");
});

test("computeRulePrecision: no overrides -> decided is 0 and precision is null (unknown stays unknown, never coerced)", () => {
  const report = computeRulePrecision("missing_linked_issue", [fired("missing_linked_issue", "a#1"), fired("missing_linked_issue", "a#2")], []);
  assert.deepEqual(report, {
    ruleId: "missing_linked_issue",
    fired: 2,
    reversed: 0,
    confirmed: 0,
    decided: 0,
    precision: null,
  });
});

test("computeRulePrecision: mixes confirmed and reversed verdicts into a real precision", () => {
  const report = computeRulePrecision(
    "missing_linked_issue",
    [fired("missing_linked_issue", "a#1"), fired("missing_linked_issue", "a#2"), fired("missing_linked_issue", "a#3")],
    [
      override("missing_linked_issue", "a#1", "confirmed"),
      override("missing_linked_issue", "a#2", "confirmed"),
      override("missing_linked_issue", "a#3", "reversed"),
    ],
  );
  assert.equal(report.fired, 3);
  assert.equal(report.confirmed, 2);
  assert.equal(report.reversed, 1);
  assert.equal(report.decided, 3);
  assert.equal(report.precision, 2 / 3);
});

test("computeRulePrecision: 100% reversed yields precision 0, not null (a real, scored bad outcome, not an unknown one)", () => {
  const report = computeRulePrecision("bad_rule", [fired("bad_rule", "a#1")], [override("bad_rule", "a#1", "reversed")]);
  assert.equal(report.decided, 1);
  assert.equal(report.precision, 0);
});

test("computeRulePrecision: ignores fired/override events for a DIFFERENT ruleId entirely", () => {
  const report = computeRulePrecision(
    "rule_a",
    [fired("rule_a", "a#1"), fired("rule_b", "a#2")],
    [override("rule_a", "a#1", "confirmed"), override("rule_b", "a#2", "reversed")],
  );
  assert.equal(report.fired, 1);
  assert.equal(report.confirmed, 1);
  assert.equal(report.reversed, 0);
});

test("computeRulePrecision: an override with no matching fired event still counts toward decided (no cross-validation between the two lists)", () => {
  const report = computeRulePrecision("rule_a", [], [override("rule_a", "a#1", "confirmed")]);
  assert.equal(report.fired, 0);
  assert.equal(report.decided, 1);
  assert.equal(report.precision, 1);
});

test("computeRuleRepeatCount: counts only fires matching BOTH ruleId and targetKey", () => {
  const events = [
    fired("rule_a", "a#1"),
    fired("rule_a", "a#1"),
    fired("rule_a", "a#2"),
    fired("rule_b", "a#1"),
  ];
  assert.equal(computeRuleRepeatCount("rule_a", "a#1", events), 2);
  assert.equal(computeRuleRepeatCount("rule_a", "a#2", events), 1);
  assert.equal(computeRuleRepeatCount("rule_b", "a#1", events), 1);
  assert.equal(computeRuleRepeatCount("rule_a", "a#3", events), 0);
});

test("computeRuleRepeatCount: zero fired events yields 0, not an error", () => {
  assert.equal(computeRuleRepeatCount("rule_a", "a#1", []), 0);
});
