// Labeled backtest corpus builder (#8083) -- turns the calibration module's raw fired/override event history
// into a list of concrete "this rule fired against this target, and a human later said it was right/wrong"
// cases, each replayable against a different candidate rule/classifier later (see the parent epic #8082).
//
// SELF-CONTAINED, PURE: no IO, no DB, no env, no wall-clock read, and no imports beyond the existing
// RuleFiredEvent/HumanOverrideEvent types from signal-tracking.ts -- the same storage-agnostic discipline
// that whole module follows. `Date.parse` on the events' own `occurredAt` strings is not a clock read; it is
// pure parsing of caller-supplied data, so the function stays deterministic.

import type { HumanOverrideEvent, RuleFiredEvent } from "./signal-tracking.js";

/** One labeled backtest case: a single rule firing paired with the human verdict that later decided it.
 *  `outcome` is the firing's own `RuleFiredEvent.outcome`; `label` is the paired `HumanOverrideEvent.verdict`
 *  (`"reversed"` = the rule was wrong that time, `"confirmed"` = it was right); `firedAt`/`decidedAt` are the
 *  two events' `occurredAt`. `metadata` carries the firing's own metadata, omitted entirely (never set to
 *  `undefined`) when the firing has none -- the same optional-property discipline `RuleFiredEvent` uses. */
export type BacktestCase = {
  ruleId: string;
  targetKey: string;
  outcome: string;
  label: "reversed" | "confirmed";
  firedAt: string;
  decidedAt: string;
  metadata?: Record<string, unknown>;
};

/**
 * Build a labeled {@link BacktestCase} corpus for `ruleId` from its fired + override events. Only events whose
 * `ruleId` matches the argument are considered (mirrors `overrideMatchesRule` in signal-tracking.ts:
 * `event.ruleId === ruleId`); a caller MAY pass a mixed-rule list without filtering first.
 *
 * A firing with no matching override (same rule AND same `targetKey`) is EXCLUDED, not emitted as an
 * unlabeled case -- the same "only the decided ones count" discipline as {@link computeRulePrecision}.
 *
 * Pairing when a `targetKey` was fired + judged more than once: each firing takes the override whose
 * `occurredAt` is the nearest one STRICTLY AFTER that firing; if no override strictly follows it, the most
 * recent override by `occurredAt` is used. Each firing yields at most one case (no duplicates for one firing).
 */
export function buildBacktestCorpus(
  ruleId: string,
  fired: readonly RuleFiredEvent[],
  overrides: readonly HumanOverrideEvent[],
): BacktestCase[] {
  // Mirrors overrideMatchesRule's one-line filter (event.ruleId === ruleId) in signal-tracking.ts.
  const ruleOverrides = overrides.filter((override) => override.ruleId === ruleId);
  const cases: BacktestCase[] = [];
  for (const firing of fired) {
    if (firing.ruleId !== ruleId) continue;
    const candidates = ruleOverrides.filter((override) => override.targetKey === firing.targetKey);
    if (candidates.length === 0) continue;
    const firedMs = Date.parse(firing.occurredAt);
    // candidates ascending by time: the first one strictly after the firing is the nearest-following match;
    // when none follows, sorted[last] is the most-recent override overall (the documented fallback).
    const sorted = [...candidates].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    const decided = sorted.find((override) => Date.parse(override.occurredAt) > firedMs) ?? sorted[sorted.length - 1]!;
    const backtestCase: BacktestCase = {
      ruleId,
      targetKey: firing.targetKey,
      outcome: firing.outcome,
      label: decided.verdict,
      firedAt: firing.occurredAt,
      decidedAt: decided.occurredAt,
    };
    if (firing.metadata !== undefined) backtestCase.metadata = firing.metadata;
    cases.push(backtestCase);
  }
  return cases;
}
