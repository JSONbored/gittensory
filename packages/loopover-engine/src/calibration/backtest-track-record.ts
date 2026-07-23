// REGRESSED-verdict track-record aggregation (#8140, parent epic #8082) -- turns the individual
// BacktestComparison results the advisory CI check persists (#8138) into the summary #8105's Phase-2
// merge-gating decision actually needs: how often REGRESSED fired, per rule, against the totals.
//
// Pure, like everything in this module: no IO, no wall-clock reads. The thin CLI wrapper does the reading.

import type { BacktestComparison } from "./backtest-compare.js";

export type RegressedVerdictRuleBreakdown = {
  total: number;
  regressed: number;
  improved: number;
  unchanged: number;
};

export type RegressedVerdictTrackRecord = {
  totalRuns: number;
  regressedRuns: number;
  /** regressedRuns / totalRuns, or null when totalRuns is 0 -- the same "unknown stays unknown, never
   *  coerced to 0" discipline as BacktestScoreReport's own null rates. */
  regressedRate: number | null;
  perRule: Map<string, RegressedVerdictRuleBreakdown>;
};

/** Aggregate historical comparisons into the #8105 decision summary. Verdict counting is exhaustive per
 *  comparison; per-rule buckets are keyed by each comparison's own ruleId. */
export function computeRegressedVerdictTrackRecord(comparisons: readonly BacktestComparison[]): RegressedVerdictTrackRecord {
  const perRule = new Map<string, RegressedVerdictRuleBreakdown>();
  let regressedRuns = 0;
  for (const comparison of comparisons) {
    const bucket = perRule.get(comparison.ruleId) ?? { total: 0, regressed: 0, improved: 0, unchanged: 0 };
    bucket.total += 1;
    if (comparison.verdict === "regressed") {
      bucket.regressed += 1;
      regressedRuns += 1;
    } else if (comparison.verdict === "improved") {
      bucket.improved += 1;
    } else {
      bucket.unchanged += 1;
    }
    perRule.set(comparison.ruleId, bucket);
  }
  return {
    totalRuns: comparisons.length,
    regressedRuns,
    regressedRate: comparisons.length > 0 ? regressedRuns / comparisons.length : null,
    perRule,
  };
}
