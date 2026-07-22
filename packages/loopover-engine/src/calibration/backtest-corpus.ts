// Backtest corpus builder (#8083, part of the rule-precision backtest epic #8082) -- turns the calibration
// module's raw fired/override event history into a list of concrete, individually-labeled cases ("this rule
// fired against this target, and a human later said it was right/wrong"), replayable against a different
// candidate rule/classifier later. Where computeRulePrecision (signal-tracking.ts) collapses the paired events
// into one aggregate precision number, this keeps each decided case as its own record.
//
// SELF-CONTAINED / PURE: no IO, no DB, no host adapters -- only the existing RuleFiredEvent/HumanOverrideEvent
// types from signal-tracking.ts, matching that module's storage-agnostic discipline.

import type { HumanOverrideEvent, RuleFiredEvent } from "./signal-tracking.js";

/** One decided backtest case: a rule firing that a human later judged. `outcome` is the fired event's own
 *  outcome; `label` is the human `verdict` on it; `firedAt`/`decidedAt` are the two events' `occurredAt`
 *  timestamps. `metadata` carries the fired event's metadata verbatim and is omitted entirely (not set to
 *  `undefined`) when the fired event has none -- the same optional-property discipline RuleFiredEvent uses. */
export type BacktestCase = {
  ruleId: string;
  targetKey: string;
  outcome: string;
  label: "reversed" | "confirmed";
  firedAt: string;
  decidedAt: string;
  metadata?: Record<string, unknown>;
};

/** Pick the override to pair with one fired event from the already-filtered (same rule + same targetKey)
 *  candidates: the one whose `occurredAt` is the nearest STRICTLY AFTER the fired event's `occurredAt`; if none
 *  strictly follows it, the most recent override by `occurredAt`. `candidates` is guaranteed non-empty by the
 *  caller. */
function pickPairedOverride(firedEvent: RuleFiredEvent, candidates: readonly HumanOverrideEvent[]): HumanOverrideEvent {
  const firedMs = Date.parse(firedEvent.occurredAt);
  let mostRecent = candidates[0]!;
  let nearestFollowing: HumanOverrideEvent | null = null;
  for (const override of candidates) {
    const overrideMs = Date.parse(override.occurredAt);
    if (overrideMs > Date.parse(mostRecent.occurredAt)) mostRecent = override;
    if (overrideMs > firedMs && (nearestFollowing === null || overrideMs < Date.parse(nearestFollowing.occurredAt))) {
      nearestFollowing = override;
    }
  }
  return nearestFollowing ?? mostRecent;
}

/**
 * Build the labeled backtest corpus for `ruleId` from its fired + override events. Only events whose `ruleId`
 * matches the argument are considered (mirrors overrideMatchesRule's `event.ruleId === ruleId` filter in
 * signal-tracking.ts; a caller MAY pass a mixed-rule list without filtering first). Each considered fired
 * event pairs with exactly ONE override sharing its `targetKey`: the override whose `occurredAt` is the nearest
 * strictly after the fired event's, or -- when none strictly follows -- the most recent override by
 * `occurredAt`. A fired event with no matching override is EXCLUDED (an undecided fire is not an unlabeled
 * case), mirroring computeRulePrecision's "only the decided ones count" discipline. No fired event yields more
 * than one case.
 */
export function buildBacktestCorpus(
  ruleId: string,
  fired: readonly RuleFiredEvent[],
  overrides: readonly HumanOverrideEvent[],
): BacktestCase[] {
  const corpus: BacktestCase[] = [];
  for (const firedEvent of fired) {
    if (firedEvent.ruleId !== ruleId) continue;
    const candidates = overrides.filter(
      (override) => override.ruleId === ruleId && override.targetKey === firedEvent.targetKey,
    );
    if (candidates.length === 0) continue;
    const paired = pickPairedOverride(firedEvent, candidates);
    const backtestCase: BacktestCase = {
      ruleId,
      targetKey: firedEvent.targetKey,
      outcome: firedEvent.outcome,
      label: paired.verdict,
      firedAt: firedEvent.occurredAt,
      decidedAt: paired.occurredAt,
    };
    if (firedEvent.metadata !== undefined) backtestCase.metadata = firedEvent.metadata;
    corpus.push(backtestCase);
  }
  return corpus;
}
