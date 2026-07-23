// Threshold-only backtest advisory (#8138, epic #8082). We already record fired/reversed history for every
// isConfiguredGateBlocker code (#7982/#8101/#8104) -- this module is the bounded analysis core: detect
// whether THIS PR changes one of a small, known set of confidence-threshold constants, and if so, prepare
// the pure backtest inputs. NO gate wiring, NO I/O, NO D1 access here -- the caller (threshold-backtest-run.ts)
// supplies the already-fetched corpus, exactly like linked-issue-satisfaction.ts's own "pure analysis core,
// I/O stays with the caller" contract.
//
// Deliberately NOT CI: this was originally built as a separate GitHub Actions workflow shelling out to
// `wrangler d1 execute`, duplicating ORB's own already-running diff fetch and D1 access and posting a SECOND
// bot comment. Reworked to live inside ORB's existing review pass instead -- one unified comment, one D1
// connection, zero new CI surface.
import { renderBacktestComparison, runThresholdBacktest, type BacktestCase, type BacktestComparison } from "@loopover/engine";

/** The two threshold constants this advisory is scoped to -- not a generic "any numeric constant changed"
 *  detector. Each maps to the ruleId(s) its value actually gates. */
export const KNOWN_THRESHOLDS: Readonly<Record<string, { readonly ruleIds: readonly string[] }>> = Object.freeze({
  LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR: { ruleIds: ["linked_issue_scope_mismatch"] },
  DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE: { ruleIds: ["ai_consensus_defect", "ai_review_split"] },
});

export type ChangedThreshold = {
  constantName: string;
  oldValue: number;
  newValue: number;
  ruleIds: readonly string[];
};

const CHANGED_LINE_PATTERN = /^([-+])export const (\w+) = ([\d.]+);/;

/**
 * Scan a unified diff for a changed value of one of `KNOWN_THRESHOLDS`' constant names. Matches a `-`
 * (old) and `+` (new) line for the same constant; a constant with anything other than exactly one `-`
 * value and one `+` value (added-only, removed-only, or multiple conflicting edits) is skipped as
 * ambiguous rather than guessed at. A pair whose old and new values are identical (e.g. pure
 * reformatting) is also skipped -- nothing actually changed. Must be given an UNBUDGETED diff (mirror
 * `buildSecretScanDiff`'s contract, not `buildAiReviewDiff`'s bounded/hunk-dropping one) -- a truncated
 * diff could silently miss the very line this function needs to see.
 */
export function detectChangedThresholds(diff: string): ChangedThreshold[] {
  const oldValues = new Map<string, number[]>();
  const newValues = new Map<string, number[]>();
  for (const line of diff.split("\n")) {
    const match = CHANGED_LINE_PATTERN.exec(line);
    if (!match) continue;
    const [, sign, name, valueText] = match;
    if (!Object.hasOwn(KNOWN_THRESHOLDS, name!)) continue;
    const value = Number(valueText);
    if (!Number.isFinite(value)) continue;
    const bucket = sign === "-" ? oldValues : newValues;
    const existing = bucket.get(name!) ?? [];
    existing.push(value);
    bucket.set(name!, existing);
  }

  const changed: ChangedThreshold[] = [];
  for (const constantName of Object.keys(KNOWN_THRESHOLDS)) {
    const oldMatches = oldValues.get(constantName) ?? [];
    const newMatches = newValues.get(constantName) ?? [];
    if (oldMatches.length !== 1 || newMatches.length !== 1) continue;
    const [oldValue] = oldMatches;
    const [newValue] = newMatches;
    if (oldValue === newValue) continue;
    changed.push({ constantName, oldValue: oldValue!, newValue: newValue!, ruleIds: KNOWN_THRESHOLDS[constantName]!.ruleIds });
  }
  return changed;
}

/** Pure: score one changed threshold against its already-fetched corpus. The caller supplies `cases`
 *  per-ruleId (via createSignalStore(env).queryRuleHistory in threshold-backtest-run.ts) -- this function
 *  never touches D1 itself. */
export function backtestChangedThreshold(change: ChangedThreshold, corpusByRuleId: ReadonlyMap<string, readonly BacktestCase[]>): BacktestComparison[] {
  return change.ruleIds.map((ruleId) => runThresholdBacktest(ruleId, corpusByRuleId.get(ruleId) ?? [], change.oldValue, change.newValue));
}

/** Render every comparison as one unified-comment section body, or "" when there's nothing to show --
 *  mirrors unified-comment.ts's own `xxxBlock(...) -> "" when absent` convention exactly, so the caller can
 *  omit the section the same way linkedIssueSatisfactionBlock does. */
export function thresholdBacktestBlock(comparisons: readonly BacktestComparison[]): string {
  if (comparisons.length === 0) return "";
  return comparisons.map((comparison) => renderBacktestComparison(comparison)).join("\n\n");
}
