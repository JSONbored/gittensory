// Bounded loosenable-knob registry (#8159, sub-issue of epic #8121). The #8121 narrow start hardcoded ONE
// loosenable value (the satisfaction floor); this registry generalizes the shape the same way
// KNOWN_THRESHOLDS (threshold-backtest.ts) and KNOWN_LOGIC_RULES (backtest-logic-check-core.ts) declare
// their surfaces: each knob is a declarative entry — rule id, candidate steps, hard bounds, split
// discipline — evaluated by ONE generic function, never per-knob bespoke loops.
//
// Every knob keeps the narrow start's invariants verbatim: smallest-step-first, strictly `improved` on the
// visible split AND non-`regressed` on the deterministic held-out split, a hard safety minimum no evidence
// can cross, and never-on-noise sample floors. A knob additionally declares whether its apply path is LIVE
// (an override consumer exists) or REPORT-ONLY (proposals surface with full evidence, but nothing may be
// written until the consumption plumbing ships — adding a consumer is a deliberate, per-knob decision, not
// a registry edit side effect).
import {
  buildConfidenceThresholdClassifier,
  compareBacktestScores,
  compareDirectionalBacktestScores,
  scoreBacktest,
  splitBacktestCorpus,
  type BacktestCase,
  type BacktestComparison,
} from "@loopover/engine";
import { LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR } from "./linked-issue-satisfaction";
import { DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE, DEFAULT_SLOP_BLOCK_THRESHOLD } from "../rules/advisory";

export type LoosenableKnob = {
  /** Stable id — used in override flag keys, audit events, and advisor labels. Never rename. */
  knobId: string;
  ruleId: string;
  shippedValue: number;
  /** Which way LOOSER points (#8224): a `floor` knob (a rule fires at/above the value; every pre-#8224
   *  entry) loosens DOWNWARD; a `ceiling` knob (a gate blocks at/above the value — slop) loosens UPWARD,
   *  raising the cap so fewer PRs block. The classifier math is identical either way (both knob families
   *  fire on value >= threshold, so buildConfidenceThresholdClassifier applies unchanged) — orientation
   *  only decides which side of shipped the candidates sit on and which hard bound applies. */
  orientation: "floor" | "ceiling";
  /** Candidate loosened values, nearest-to-shipped first — the smallest evidence-cleared step wins.
   *  Floor knobs: strictly below shipped, descending. Ceiling knobs: strictly above shipped, ascending. */
  candidates: readonly number[];
  /** Floor knobs: no backtest result, however good, may loosen below this. Ceiling knobs declare the
   *  mirror bound in {@link LoosenableKnob.hardMaximum} instead and set this to the shipped value (it
   *  still bounds the drift pool's tighter side). */
  hardMinimum: number;
  /** Ceiling knobs only (#8224): no backtest result may loosen (raise) the cap above this. */
  hardMaximum?: number;
  minVisibleCases: number;
  minHeldOutCases: number;
  heldOutFraction: number;
  /** Fixed per-knob split seed — held-out membership must never reshuffle between evaluations. */
  splitSeed: string;
  /** `live`: an override consumer exists and the apply path may write. `report_only`: proposals surface
   *  (advisor/status) but the apply path REFUSES — flipping a knob to live requires shipping its
   *  consumption plumbing first, reviewed on its own. */
  applyMode: "live" | "report_only";
  /** system_flags key holding this knob's live override (migration 0054's operational-flag table). */
  overrideFlagKey: string;
  /** Audit event type an apply writes — a knob's evidence trail keeps ONE stable type forever. */
  looseningEventType: string;
  /** Truthy-string wrangler var double-gating this knob's autotune loop AND its override read. */
  autotuneEnvVar: string;
  /** OPTIONAL tightening ladder (#8225, epic #8211 track D) — declared only for knobs whose tighter drift
   *  findings may ACT. Tightening is judged by the direction-aware comparator under the ladder's OWN
   *  declared axes orientation (win axis strictly up; the other bounded), never the symmetric floor
   *  reused blind. Its autonomy is gated by its OWN env var, separate from loosening and default off. */
  tightening?: KnobTighteningLadder;
};

export type KnobTighteningLadder = {
  /** Candidate tightened values, nearest-to-shipped first — the smallest evidence-cleared raise wins. */
  candidates: readonly number[];
  /** No backtest result, however good, may tighten above this. */
  hardMaximum: number;
  /** The EXPLICIT axes orientation of this knob's tightening trade (#8225): which axis a raise exists to
   *  win (for the confidence-threshold corpus polarity, RAISING helps recall and risks precision) and the
   *  bounded sacrifice the other axis may suffer per comparison slice. */
  mustImprove: "precision" | "recall";
  maxSacrifice: number;
  /** Truthy-string wrangler var gating the tighten loop AND the above-shipped override read. Default off. */
  autotuneEnvVar: string;
  /** Audit event type a tightening apply writes — one stable type per knob-direction, forever. */
  eventType: string;
};

export const LOOSENABLE_KNOBS: Readonly<Record<string, LoosenableKnob>> = Object.freeze({
  // #8121's approved narrow start — fully live (override consumed by runLoopOverLinkedIssueSatisfaction).
  // Values and seed are IDENTICAL to the pre-registry constants: behavior and held-out membership are
  // byte-stable across this refactor.
  satisfaction_floor: {
    knobId: "satisfaction_floor",
    ruleId: "linked_issue_scope_mismatch",
    orientation: "floor",
    shippedValue: LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR,
    candidates: [0.45, 0.4, 0.35, 0.3],
    hardMinimum: 0.3,
    minVisibleCases: 20,
    minHeldOutCases: 5,
    heldOutFraction: 0.25,
    splitSeed: "satisfaction-floor-loosening-v1",
    applyMode: "live",
    // Literals (not imports) to keep this registry dependency-light; the invariant test pins them to the
    // run module's exported constants so they can never drift.
    overrideFlagKey: "satisfaction_floor_override",
    looseningEventType: "calibration.satisfaction_floor_loosened",
    autotuneEnvVar: "SATISFACTION_FLOOR_AUTOTUNE_ENABLED",
  },
  // The AI close-confidence floor (#8159's second knob), LIVE since #8176: the override is consumed as the
  // gate policy's DEFAULT (gate-checks.ts threads it under `settings.aiReviewCloseConfidence ?? override`),
  // so an explicit per-repo `gate.aiReview.closeConfidence` ALWAYS wins — the knob only moves the default.
  // Loosening it means MORE auto-closes (a direct gate-authority change), hence the double gating: the
  // AI_REVIEW_CLOSE_CONFIDENCE_AUTOTUNE_ENABLED var must be ON for both the loop and the override read,
  // and its corpus floors are the registry's strictest. Tight bounds by design: two steps, hard floor 0.85.
  ai_review_close_confidence: {
    knobId: "ai_review_close_confidence",
    ruleId: "ai_consensus_defect",
    orientation: "floor",
    shippedValue: DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE,
    candidates: [0.9, 0.85],
    hardMinimum: 0.85,
    minVisibleCases: 50,
    minHeldOutCases: 12,
    heldOutFraction: 0.25,
    splitSeed: "ai-close-confidence-loosening-v1",
    applyMode: "live",
    overrideFlagKey: "ai_review_close_confidence_override",
    looseningEventType: "calibration.ai_review_close_confidence_loosened",
    autotuneEnvVar: "AI_REVIEW_CLOSE_CONFIDENCE_AUTOTUNE_ENABLED",
    // #8225's first tightening ladder: a HIGHER close-confidence bar means FEWER auto-closes — strictly
    // caution-ward, the correct direction to trust first. Two steps, hard ceiling 0.97, tight sacrifice
    // budget.
    tightening: {
      candidates: [0.95, 0.97],
      hardMaximum: 0.97,
      // Corpus polarity: the threshold classifier's positive class is "predicted reversed", so raising the
      // bar catches MORE genuinely-reversed closes (recall, the win) at the risk of withholding good ones
      // (precision, the bounded sacrifice — at most 5 points per slice).
      mustImprove: "recall",
      maxSacrifice: 0.05,
      autotuneEnvVar: "AI_REVIEW_CLOSE_CONFIDENCE_TIGHTEN_ENABLED",
      eventType: "calibration.ai_review_close_confidence_tightened",
    },
  },
  // #8224: the slop gate's block threshold enters REPORT-ONLY — proposals surface with full evidence in
  // the advisor and the knobs endpoint; the apply path refuses until a flip-to-live ships as its own
  // reviewed change, and per #8224 that issue gets filed only AFTER proposals with real evidence exist.
  // The registry's first CEILING knob: the gate blocks when slopRisk/100 >= this value (advisory.ts's
  // recordRuleFired writes confidence = risk/100 with shipped DEFAULT_SLOP_BLOCK_THRESHOLD), so LOOSER
  // means RAISING the cap. Bounds rationale (tighter than close-confidence's, per the issue): this value
  // gates contributor-facing verdicts directly, so two small steps (+0.05, +0.10) and a hard ceiling of
  // 0.70 — beyond that a "slop gate" that only blocks 70+/100 risk isn't gating. Sample floors match the
  // close-confidence knob's strictest-in-registry 50/12 given score noisiness.
  //
  // quality_gate_score deliberately does NOT enter (#8224's recorded finding): qualityGateMinScore is
  // per-repo nullable with NO global shipped default, and a registry entry anchors the whole discipline
  // on the shipped constant. It stays out until a global default exists.
  slop_gate_score: {
    knobId: "slop_gate_score",
    ruleId: "slop_gate_score",
    orientation: "ceiling",
    shippedValue: DEFAULT_SLOP_BLOCK_THRESHOLD / 100,
    candidates: [0.65, 0.7],
    hardMinimum: DEFAULT_SLOP_BLOCK_THRESHOLD / 100,
    hardMaximum: 0.7,
    minVisibleCases: 50,
    minHeldOutCases: 12,
    heldOutFraction: 0.25,
    splitSeed: "slop-gate-loosening-v1",
    applyMode: "report_only",
    overrideFlagKey: "slop_gate_score_override",
    looseningEventType: "calibration.slop_gate_score_loosened",
    autotuneEnvVar: "SLOP_GATE_SCORE_AUTOTUNE_ENABLED",
  },
});

export type KnobLooseningProposal = {
  knobId: string;
  ruleId: string;
  currentValue: number;
  proposedValue: number;
  visibleCases: number;
  heldOutCases: number;
  visible: BacktestComparison;
  heldOut: BacktestComparison;
};

/**
 * Evaluate whether `knob` can be safely loosened from `currentValue` — the generic form of the #8121
 * narrow start's gate, parameterized by the registry entry and nothing else: the smallest candidate step
 * below `currentValue` (never below the knob's hard minimum) whose backtest verdict is strictly
 * `"improved"` on the visible split AND non-`"regressed"` on the held-out split. Null when the corpus is
 * too small, no candidate qualifies, or the current value already sits at/below the hard minimum. Pure and
 * deterministic — same knob + corpus + value ⇒ same proposal.
 */
export function evaluateKnobLoosening(
  knob: LoosenableKnob,
  cases: readonly BacktestCase[],
  currentValue: number = knob.shippedValue,
): KnobLooseningProposal | null {
  const { visible, heldOut } = splitBacktestCorpus(cases, knob.heldOutFraction, knob.splitSeed);
  if (visible.length < knob.minVisibleCases || heldOut.length < knob.minHeldOutCases) return null;

  for (const candidate of knob.candidates) {
    // Orientation decides which way "looser" points (#8224): floor knobs step DOWN toward hardMinimum,
    // ceiling knobs step UP toward hardMaximum. Same evidence discipline either way.
    const loosens =
      knob.orientation === "ceiling"
        ? candidate > currentValue && candidate <= (knob.hardMaximum ?? currentValue)
        : candidate < currentValue && candidate >= knob.hardMinimum;
    if (!loosens) continue;
    const visibleComparison = compareOnSlice(knob.ruleId, visible, currentValue, candidate);
    if (visibleComparison.verdict !== "improved") continue;
    const heldOutComparison = compareOnSlice(knob.ruleId, heldOut, currentValue, candidate);
    if (heldOutComparison.verdict === "regressed") continue;
    return {
      knobId: knob.knobId,
      ruleId: knob.ruleId,
      currentValue,
      proposedValue: candidate,
      visibleCases: visible.length,
      heldOutCases: heldOut.length,
      visible: visibleComparison,
      heldOut: heldOutComparison,
    };
  }
  return null;
}

export type KnobTighteningProposal = {
  knobId: string;
  ruleId: string;
  currentValue: number;
  proposedValue: number;
  visibleCases: number;
  heldOutCases: number;
  visible: BacktestComparison;
  heldOut: BacktestComparison;
};

/**
 * Evaluate whether `knob` can be justifiably TIGHTENED from `currentValue` (#8225) — the direction mirror
 * of {@link evaluateKnobLoosening} with the orientation made explicit instead of reused blind: the smallest
 * declared candidate ABOVE `currentValue` (never above the ladder's hard maximum) whose direction-aware
 * verdict is strictly `"improved"` on the visible split AND non-`"regressed"` on the held-out split, where
 * improved means the ladder's declared win axis strictly up and any cost on the other axis within its
 * declared sacrifice bound.
 * Same split seed/fraction and the same never-on-noise sample floors as the loosening side — held-out
 * membership is identical for both directions of the same knob. Null when the knob declares no ladder, the
 * corpus is too small, no candidate qualifies, or the current value already sits at/above the hard maximum.
 * Pure and deterministic — same knob + corpus + value ⇒ same proposal.
 */
export function evaluateKnobTightening(
  knob: LoosenableKnob,
  cases: readonly BacktestCase[],
  currentValue: number = knob.shippedValue,
): KnobTighteningProposal | null {
  const ladder = knob.tightening;
  if (!ladder) return null;
  const { visible, heldOut } = splitBacktestCorpus(cases, knob.heldOutFraction, knob.splitSeed);
  if (visible.length < knob.minVisibleCases || heldOut.length < knob.minHeldOutCases) return null;

  for (const candidate of ladder.candidates) {
    if (candidate <= currentValue || candidate > ladder.hardMaximum) continue;
    const visibleComparison = compareTighteningOnSlice(knob.ruleId, visible, currentValue, candidate, ladder);
    if (visibleComparison.verdict !== "improved") continue;
    const heldOutComparison = compareTighteningOnSlice(knob.ruleId, heldOut, currentValue, candidate, ladder);
    if (heldOutComparison.verdict === "regressed") continue;
    return {
      knobId: knob.knobId,
      ruleId: knob.ruleId,
      currentValue,
      proposedValue: candidate,
      visibleCases: visible.length,
      heldOutCases: heldOut.length,
      visible: visibleComparison,
      heldOut: heldOutComparison,
    };
  }
  return null;
}

export type KnobDriftDirection = "looser" | "tighter" | "shipped";

export type KnobDriftReport = {
  knobId: string;
  ruleId: string;
  liveValue: number;
  dominatingValue: number;
  /** `"shipped"` when the dominating alternative IS the registry's shipped value (a drifted override should
   *  revert -- checked FIRST, before the looser/tighter reading); otherwise `"looser"` (below live) or
   *  `"tighter"` (above live). The consumer's messaging differs: a looser winner duplicates the loosening
   *  loop's own proposal (informational), a tighter winner means live config is likely stale (actionable). */
  direction: KnobDriftDirection;
  visibleCases: number;
  heldOutCases: number;
  visible: BacktestComparison;
  heldOut: BacktestComparison;
};

/**
 * Evaluate whether ANY alternative setting Pareto-dominates the live value on the trailing corpus (#8212,
 * epic #8211 track A) -- the inverse operator question to {@link evaluateKnobLoosening}: not "can we safely
 * loosen?" but "is what is CURRENTLY live still the best-supported setting, in either direction?". Same
 * discipline verbatim: the knob's own split seed/fraction, the same Pareto floor (strictly `"improved"` on
 * the visible split AND non-`"regressed"` on the deterministic held-out split), the same never-on-noise
 * sample minimums, and the hard minimum no evidence may cross. The candidate pool is every registry
 * candidate PLUS the shipped value (a TIGHTER alternative dominating live is exactly the stale-config
 * signal), minus the live value itself; alternatives are tried nearest-to-live first (the minimal config
 * change wins, mirroring smallest-step-first; equidistant ties prefer the higher/tighter value,
 * deterministically). Null -- never a guess -- when the corpus misses the sample floors or nothing strictly
 * dominates. Pure and deterministic: same knob + corpus + value ⇒ same report.
 */
export function evaluateKnobDrift(
  knob: LoosenableKnob,
  cases: readonly BacktestCase[],
  liveValue: number = knob.shippedValue,
): KnobDriftReport | null {
  const { visible, heldOut } = splitBacktestCorpus(cases, knob.heldOutFraction, knob.splitSeed);
  if (visible.length < knob.minVisibleCases || heldOut.length < knob.minHeldOutCases) return null;

  // #8225: a declared tightening ladder joins the pool, so the sentinel's tighter findings and the tighten
  // apply path judge the SAME candidate values (bounded by the ladder's own hard maximum via declaration).
  // #8224: ceiling knobs bound the pool from above (hardMaximum) instead of below.
  const alternatives = [...new Set([knob.shippedValue, ...knob.candidates, ...(knob.tightening?.candidates ?? [])])]
    .filter((value) =>
      value !== liveValue && (knob.orientation === "ceiling" ? value <= (knob.hardMaximum ?? knob.shippedValue) : value >= knob.hardMinimum),
    )
    .sort((left, right) => Math.abs(left - liveValue) - Math.abs(right - liveValue) || right - left);

  for (const alternative of alternatives) {
    const visibleComparison = compareOnSlice(knob.ruleId, visible, liveValue, alternative);
    if (visibleComparison.verdict !== "improved") continue;
    const heldOutComparison = compareOnSlice(knob.ruleId, heldOut, liveValue, alternative);
    if (heldOutComparison.verdict === "regressed") continue;
    return {
      knobId: knob.knobId,
      ruleId: knob.ruleId,
      liveValue,
      dominatingValue: alternative,
      // Orientation decides the label (#8224): for a ceiling knob a HIGHER alternative is the looser one.
      direction:
        alternative === knob.shippedValue
          ? "shipped"
          : (knob.orientation === "ceiling" ? alternative > liveValue : alternative < liveValue)
            ? "looser"
            : "tighter",
      visibleCases: visible.length,
      heldOutCases: heldOut.length,
      visible: visibleComparison,
      heldOut: heldOutComparison,
    };
  }
  return null;
}

function compareOnSlice(ruleId: string, slice: readonly BacktestCase[], currentValue: number, candidate: number): BacktestComparison {
  const baseline = scoreBacktest(ruleId, slice, buildConfidenceThresholdClassifier(currentValue));
  const proposed = scoreBacktest(ruleId, slice, buildConfidenceThresholdClassifier(candidate));
  return compareBacktestScores(baseline, proposed);
}

function compareTighteningOnSlice(
  ruleId: string,
  slice: readonly BacktestCase[],
  currentValue: number,
  candidate: number,
  ladder: KnobTighteningLadder,
): BacktestComparison {
  const baseline = scoreBacktest(ruleId, slice, buildConfidenceThresholdClassifier(currentValue));
  const proposed = scoreBacktest(ruleId, slice, buildConfidenceThresholdClassifier(candidate));
  return compareDirectionalBacktestScores(baseline, proposed, { mustImprove: ladder.mustImprove, maxSacrifice: ladder.maxSacrifice });
}
