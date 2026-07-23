import { describe, expect, it } from "vitest";
import { splitBacktestCorpus, type BacktestCase } from "@loopover/engine";
import { evaluateKnobDrift, evaluateKnobLoosening, evaluateKnobTightening, LOOSENABLE_KNOBS, type LoosenableKnob } from "../../src/services/loosening-knobs";
import {
  SATISFACTION_FLOOR_HARD_MINIMUM,
  SATISFACTION_FLOOR_HELD_OUT_FRACTION,
  SATISFACTION_FLOOR_LOOSENING_CANDIDATES,
  SATISFACTION_FLOOR_MIN_HELD_OUT_CASES,
  SATISFACTION_FLOOR_MIN_VISIBLE_CASES,
  SATISFACTION_FLOOR_RULE_ID,
  SATISFACTION_FLOOR_SPLIT_SEED,
} from "../../src/services/satisfaction-floor-loosening";
import { LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR } from "../../src/services/linked-issue-satisfaction";
import { DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE, DEFAULT_SLOP_BLOCK_THRESHOLD } from "../../src/rules/advisory";
import { buildKnobReliabilityRecs, buildReportOnlyKnobRecs } from "../../src/review/loosening-recs";

const AI_KNOB = LOOSENABLE_KNOBS.ai_review_close_confidence!;

describe("LOOSENABLE_KNOBS registry invariants (#8159)", () => {
  it("pins the satisfaction knob to the #8121 narrow start's exact values and seed — behavior and held-out membership stay byte-stable", () => {
    expect(LOOSENABLE_KNOBS.satisfaction_floor).toEqual({
      knobId: "satisfaction_floor",
      ruleId: SATISFACTION_FLOOR_RULE_ID,
      orientation: "floor",
      shippedValue: LINKED_ISSUE_SATISFACTION_CONFIDENCE_FLOOR,
      candidates: SATISFACTION_FLOOR_LOOSENING_CANDIDATES,
      hardMinimum: SATISFACTION_FLOOR_HARD_MINIMUM,
      minVisibleCases: SATISFACTION_FLOOR_MIN_VISIBLE_CASES,
      minHeldOutCases: SATISFACTION_FLOOR_MIN_HELD_OUT_CASES,
      heldOutFraction: SATISFACTION_FLOOR_HELD_OUT_FRACTION,
      splitSeed: SATISFACTION_FLOOR_SPLIT_SEED,
      applyMode: "live",
      // #8176's apply plumbing — pinned to the legacy run module's constants by knob-loosening-run.test.ts.
      overrideFlagKey: "satisfaction_floor_override",
      looseningEventType: "calibration.satisfaction_floor_loosened",
      autotuneEnvVar: "SATISFACTION_FLOOR_AUTOTUNE_ENABLED",
    });
  });

  it("pins the close-confidence knob to the shipped default, tight bounds, and its LIVE apply plumbing (#8176)", () => {
    expect(AI_KNOB.shippedValue).toBe(DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE);
    expect(AI_KNOB.ruleId).toBe("ai_consensus_defect");
    expect(AI_KNOB.applyMode).toBe("live"); // flipped by #8176 — the override consumer ships with it
    expect(AI_KNOB.hardMinimum).toBe(0.85);
    expect(AI_KNOB.overrideFlagKey).toBe("ai_review_close_confidence_override");
    expect(AI_KNOB.looseningEventType).toBe("calibration.ai_review_close_confidence_loosened");
    expect(AI_KNOB.autotuneEnvVar).toBe("AI_REVIEW_CLOSE_CONFIDENCE_AUTOTUNE_ENABLED");
  });

  it("every entry satisfies the structural safety invariants: candidates strictly below shipped, at/above the hard minimum, descending; ids and seeds unique", () => {
    const knobs = Object.values(LOOSENABLE_KNOBS);
    for (const knob of knobs) {
      expect(knob.candidates.length).toBeGreaterThan(0);
      // #8224: orientation decides which side of shipped the loosening ladder sits on.
      if (knob.orientation === "ceiling") {
        expect(typeof knob.hardMaximum).toBe("number"); // a ceiling knob MUST declare its upper bound
        for (const candidate of knob.candidates) {
          expect(candidate).toBeGreaterThan(knob.shippedValue);
          expect(candidate).toBeLessThanOrEqual(knob.hardMaximum!);
        }
        expect([...knob.candidates].sort((a, b) => a - b)).toEqual([...knob.candidates]); // nearest-first (ascending)
        // The live apply path and the tightening ladder are floor-only machinery today — a ceiling knob
        // may not go live (or declare a ladder) until their storage/validation generalizes.
        expect(knob.applyMode).toBe("report_only");
        expect(knob.tightening).toBeUndefined();
      } else {
        for (const candidate of knob.candidates) {
          expect(candidate).toBeLessThan(knob.shippedValue);
          expect(candidate).toBeGreaterThanOrEqual(knob.hardMinimum);
        }
        expect([...knob.candidates].sort((a, b) => b - a)).toEqual([...knob.candidates]); // nearest-first (descending)
      }
      expect(knob.minVisibleCases).toBeGreaterThan(0);
      expect(knob.minHeldOutCases).toBeGreaterThan(0);
      expect(["live", "report_only"]).toContain(knob.applyMode);
    }
    for (const knob of knobs) {
      // #8225: a declared tightening ladder must be structurally safe — ascending candidates strictly
      // above shipped, none past the hard maximum, its own distinct env var and event type.
      if (!knob.tightening) continue;
      expect(knob.tightening.candidates.length).toBeGreaterThan(0);
      for (const candidate of knob.tightening.candidates) {
        expect(candidate).toBeGreaterThan(knob.shippedValue);
        expect(candidate).toBeLessThanOrEqual(knob.tightening.hardMaximum);
      }
      expect([...knob.tightening.candidates].sort((a, b) => a - b)).toEqual([...knob.tightening.candidates]); // nearest-first
      expect(knob.tightening.maxSacrifice).toBeGreaterThanOrEqual(0);
      expect(["precision", "recall"]).toContain(knob.tightening.mustImprove);
      expect(knob.tightening.autotuneEnvVar).not.toBe(knob.autotuneEnvVar);
      expect(knob.tightening.eventType).not.toBe(knob.looseningEventType);
    }
    expect(new Set(knobs.map((knob) => knob.knobId)).size).toBe(knobs.length);
    expect(new Set(knobs.map((knob) => knob.splitSeed)).size).toBe(knobs.length);
    for (const [key, knob] of Object.entries(LOOSENABLE_KNOBS)) expect(key).toBe(knob.knobId);
  });
});

// Fixture strategy mirrors the satisfaction suite: probe the real splitter for slice membership under THIS
// knob's seed/rule, then assign confidence/label per slice.
function aiCase(targetKey: string, confidence: number, label: "reversed" | "confirmed"): BacktestCase {
  return {
    ruleId: AI_KNOB.ruleId,
    targetKey,
    outcome: "close",
    label,
    firedAt: "2026-06-01T00:00:00.000Z",
    decidedAt: "2026-06-02T00:00:00.000Z",
    metadata: { confidence },
  };
}

const POOL = Array.from({ length: 400 }, (_, i) => `acme/widgets#${i + 1}`);
const probe = POOL.map((key) => aiCase(key, 0.99, "confirmed"));
const { visible, heldOut } = splitBacktestCorpus(probe, AI_KNOB.heldOutFraction, AI_KNOB.splitSeed);
const visibleKeys = visible.map((c) => c.targetKey);
const heldOutKeys = heldOut.map((c) => c.targetKey);

function aiLooseningFriendlyCorpus(): BacktestCase[] {
  const cases: BacktestCase[] = [];
  // Borderline firings a human CONFIRMED at confidence 0.91 (between candidate 0.9 and shipped 0.93):
  // baseline predicts them reversed (false positives); candidate 0.9 stops firing them — precision improves.
  for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.91, "confirmed"));
  for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.91, "confirmed"));
  // A deep-low reversed anchor per slice keeps a true positive on both sides of every comparison.
  cases.push(aiCase(visibleKeys[AI_KNOB.minVisibleCases + 10]!, 0.5, "reversed"));
  cases.push(aiCase(heldOutKeys[AI_KNOB.minHeldOutCases + 6]!, 0.5, "reversed"));
  return cases;
}

describe("evaluateKnobLoosening on the close-confidence knob (#8159)", () => {
  it("proposes the smallest candidate step with full evidence when both splits support it", () => {
    const proposal = evaluateKnobLoosening(AI_KNOB, aiLooseningFriendlyCorpus());
    expect(proposal).not.toBeNull();
    expect(proposal!.knobId).toBe("ai_review_close_confidence");
    expect(proposal!.currentValue).toBe(DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE);
    expect(proposal!.proposedValue).toBe(0.9);
    expect(proposal!.visible.verdict).toBe("improved");
    expect(proposal!.heldOut.verdict).not.toBe("regressed");
  });

  it("never loosens on a sample below THIS knob's own (higher) floors", () => {
    const thin = [
      ...visibleKeys.slice(0, AI_KNOB.minVisibleCases - 1).map((key) => aiCase(key, 0.91, "confirmed")),
      ...heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3).map((key) => aiCase(key, 0.91, "confirmed")),
    ];
    expect(evaluateKnobLoosening(AI_KNOB, thin)).toBeNull();
  });

  it("refuses to step below the hard minimum even from an already-loosened current value", () => {
    expect(evaluateKnobLoosening(AI_KNOB, aiLooseningFriendlyCorpus(), AI_KNOB.hardMinimum)).toBeNull();
  });
});

// ── #8225: the direction mirror — can the knob be justifiably TIGHTENED? ────────────────────────────────────

function aiTighteningFriendlyCorpus(): BacktestCase[] {
  // Band firings at 0.94 a human REVERSED: shipped 0.93 trusts them (missed reversals — false negatives);
  // the first tightening candidate 0.95 catches them — recall improves, precision holds at 1 (every
  // predicted-reversed case really was reversed), so the sacrifice budget is untouched.
  const cases: BacktestCase[] = [];
  for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.94, "reversed"));
  for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.94, "reversed"));
  // Deep-low reversed anchors keep a true positive on both sides of every comparison.
  cases.push(aiCase(visibleKeys[AI_KNOB.minVisibleCases + 10]!, 0.5, "reversed"));
  cases.push(aiCase(heldOutKeys[AI_KNOB.minHeldOutCases + 6]!, 0.5, "reversed"));
  return cases;
}

describe("evaluateKnobTightening (#8225)", () => {
  it("proposes the smallest ladder step with full evidence when both splits support it under the declared orientation", () => {
    const proposal = evaluateKnobTightening(AI_KNOB, aiTighteningFriendlyCorpus());
    expect(proposal).not.toBeNull();
    expect(proposal!.knobId).toBe("ai_review_close_confidence");
    expect(proposal!.currentValue).toBe(DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE);
    expect(proposal!.proposedValue).toBe(0.95);
    expect(proposal!.visible.verdict).toBe("improved");
    expect(proposal!.heldOut.verdict).not.toBe("regressed");
  });

  it("returns null for a knob that declares no ladder — tightening is opt-in per knob, never implied", () => {
    expect(evaluateKnobTightening(LOOSENABLE_KNOBS.satisfaction_floor!, aiTighteningFriendlyCorpus())).toBeNull();
  });

  it("never tightens on a sample below the knob's floors", () => {
    const thin = [
      ...visibleKeys.slice(0, AI_KNOB.minVisibleCases - 1).map((key) => aiCase(key, 0.94, "reversed")),
      ...heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3).map((key) => aiCase(key, 0.94, "reversed")),
    ];
    expect(evaluateKnobTightening(AI_KNOB, thin)).toBeNull();
  });

  it("refuses to step above the hard maximum even from an already-tightened current value", () => {
    expect(evaluateKnobTightening(AI_KNOB, aiTighteningFriendlyCorpus(), AI_KNOB.tightening!.hardMaximum)).toBeNull();
  });

  it("skips candidates at/below the current value: from 0.95 only 0.97 is a raise", () => {
    // Band moves to 0.96 so the remaining raise (0.97) is the one the evidence supports.
    const cases: BacktestCase[] = [];
    for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.96, "reversed"));
    for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.96, "reversed"));
    cases.push(aiCase(visibleKeys[AI_KNOB.minVisibleCases + 10]!, 0.5, "reversed"));
    cases.push(aiCase(heldOutKeys[AI_KNOB.minHeldOutCases + 6]!, 0.5, "reversed"));
    const proposal = evaluateKnobTightening(AI_KNOB, cases, 0.95);
    expect(proposal).not.toBeNull();
    expect(proposal!.proposedValue).toBe(0.97);
  });

  it("returns null when no candidate improves the win axis (uniform confirmed corpus)", () => {
    const uniform = [
      ...visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6).map((key) => aiCase(key, 0.99, "confirmed")),
      ...heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3).map((key) => aiCase(key, 0.99, "confirmed")),
    ];
    expect(evaluateKnobTightening(AI_KNOB, uniform)).toBeNull();
  });

  it("returns null when the visible split improves but the held-out split regresses (the transposed Pareto floor holds)", () => {
    // Visible: reversed band at 0.94 (a raise wins). Held-out: CONFIRMED at 0.94 — the raise misflags them,
    // an over-budget precision sacrifice on that slice.
    const cases: BacktestCase[] = [];
    for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.94, "reversed"));
    for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.94, "confirmed"));
    cases.push(aiCase(visibleKeys[AI_KNOB.minVisibleCases + 10]!, 0.5, "reversed"));
    cases.push(aiCase(heldOutKeys[AI_KNOB.minHeldOutCases + 6]!, 0.5, "reversed"));
    expect(evaluateKnobTightening(AI_KNOB, cases)).toBeNull();
  });

  it("is deterministic: the same corpus and current value always produce the same proposal", () => {
    const corpus = aiTighteningFriendlyCorpus();
    expect(evaluateKnobTightening(AI_KNOB, corpus)).toEqual(evaluateKnobTightening(AI_KNOB, corpus));
  });
});

describe("buildKnobReliabilityRecs (#8227)", () => {
  const status = (over: Partial<{ knobId: string; liveValue: number; reliability: { suggestion: number | null } | null }> = {}) => ({
    knobId: "ai_review_close_confidence",
    liveValue: 0.93,
    reliability: { suggestion: 0.9 },
    ...over,
  });

  it("emits one info rec per live knob whose derived suggestion differs from live — and nothing otherwise", () => {
    const recs = buildKnobReliabilityRecs([
      status(), // differs -> rec
      status({ knobId: "satisfaction_floor", liveValue: 0.5, reliability: { suggestion: 0.5 } }), // equal -> silent
      status({ knobId: "third", reliability: { suggestion: null } }), // no suggestion -> silent
      status({ knobId: "fourth", reliability: null }), // no curve -> silent
    ]);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.project).toBe("global:ai_review_close_confidence");
    expect(recs[0]!.severity).toBe("info");
    expect(recs[0]!.message).toContain("0.9");
    expect(recs[0]!.message).toContain("SURFACING ONLY");
  });
});

describe("buildReportOnlyKnobRecs (#8159)", () => {
  it("surfaces the evidence with the report-only action line and NEVER a payload", () => {
    const proposal = evaluateKnobLoosening(AI_KNOB, aiLooseningFriendlyCorpus())!;
    const recs = buildReportOnlyKnobRecs([proposal]);
    expect(recs).toHaveLength(1);
    expect(recs[0]!.project).toBe("global:ai_review_close_confidence");
    expect(recs[0]!.severity).toBe("good");
    expect(recs[0]!.message).toContain(`${DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE} → 0.9`);
    expect(recs[0]!.message).toContain("no override consumer yet");
    expect(recs[0]!.overridePayload).toBeUndefined();
    expect(buildReportOnlyKnobRecs([])).toEqual([]);
  });
});

// ── #8212: config-drift evaluation — does ANY alternative Pareto-dominate the live value? ───────────────────

describe("evaluateKnobDrift on the close-confidence knob (#8212)", () => {
  function tighterFriendlyCorpus(): BacktestCase[] {
    // Mid-band firings (0.87) a human REVERSED: live 0.85 classifies them confirmed (missed reversals --
    // false negatives), the tighter 0.9 catches them (true positives) -- recall improves, precision holds.
    const cases: BacktestCase[] = [];
    for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.87, "reversed"));
    for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.87, "reversed"));
    // Deep-low reversed anchors keep a true positive on both sides of every comparison.
    cases.push(aiCase(visibleKeys[AI_KNOB.minVisibleCases + 10]!, 0.5, "reversed"));
    cases.push(aiCase(heldOutKeys[AI_KNOB.minHeldOutCases + 6]!, 0.5, "reversed"));
    return cases;
  }

  it("reports a LOOSER dominating alternative from the shipped live value (duplicates the loosening signal)", () => {
    const report = evaluateKnobDrift(AI_KNOB, aiLooseningFriendlyCorpus());
    expect(report).not.toBeNull();
    expect(report!.knobId).toBe("ai_review_close_confidence");
    expect(report!.liveValue).toBe(DEFAULT_AI_REVIEW_CLOSE_CONFIDENCE);
    expect(report!.dominatingValue).toBe(0.9);
    expect(report!.direction).toBe("looser");
    expect(report!.visible.verdict).toBe("improved");
    expect(report!.heldOut.verdict).not.toBe("regressed");
    expect(report!.visibleCases).toBeGreaterThanOrEqual(AI_KNOB.minVisibleCases);
    expect(report!.heldOutCases).toBeGreaterThanOrEqual(AI_KNOB.minHeldOutCases);
  });

  it("reports a TIGHTER (non-shipped) dominating alternative from a loosened live value — the stale-config signal", () => {
    const report = evaluateKnobDrift(AI_KNOB, tighterFriendlyCorpus(), 0.85);
    expect(report).not.toBeNull();
    expect(report!.liveValue).toBe(0.85);
    expect(report!.dominatingValue).toBe(0.9); // nearest-to-live dominating alternative, not the farthest
    expect(report!.direction).toBe("tighter");
    expect(report!.visible.verdict).toBe("improved");
  });

  it("labels a dominating alternative that IS the shipped value as direction 'shipped' (revert-the-override signal)", () => {
    // Same mid-band-reversed shape, but at 0.91 so ONLY the shipped 0.93 catches them: live 0.9 and the
    // other candidate 0.85 both miss (0.91 >= both), so the nearest dominating alternative is shipped.
    const cases: BacktestCase[] = [];
    for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.91, "reversed"));
    for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.91, "reversed"));
    cases.push(aiCase(visibleKeys[AI_KNOB.minVisibleCases + 10]!, 0.5, "reversed"));
    cases.push(aiCase(heldOutKeys[AI_KNOB.minHeldOutCases + 6]!, 0.5, "reversed"));
    const report = evaluateKnobDrift(AI_KNOB, cases, 0.9);
    expect(report).not.toBeNull();
    expect(report!.dominatingValue).toBe(AI_KNOB.shippedValue);
    expect(report!.direction).toBe("shipped");
  });

  it("returns null when nothing strictly dominates the live value (uniform corpus, all comparisons unchanged)", () => {
    // Every case sits far below every threshold with a reversed label: all values classify identically.
    const cases: BacktestCase[] = [];
    for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.5, "reversed"));
    for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.5, "reversed"));
    expect(evaluateKnobDrift(AI_KNOB, cases)).toBeNull();
  });

  it("returns null on a sample below the knob's floors — never a drift call on noise", () => {
    const thin = [
      ...visibleKeys.slice(0, AI_KNOB.minVisibleCases - 1).map((key) => aiCase(key, 0.91, "confirmed")),
      ...heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3).map((key) => aiCase(key, 0.91, "confirmed")),
    ];
    expect(evaluateKnobDrift(AI_KNOB, thin)).toBeNull();
  });

  it("returns null when the visible split improves but the held-out split regresses (Pareto floor holds)", () => {
    // Visible: 0.91-confirmed mass (0.9 improves precision over live 0.93). Held-out: 0.91-REVERSED mass
    // (0.9 stops catching them -- recall regresses), so every looser alternative fails the held-out floor
    // and no tighter alternative exists above shipped.
    const cases: BacktestCase[] = [];
    for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.91, "confirmed"));
    for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.91, "reversed"));
    cases.push(aiCase(visibleKeys[AI_KNOB.minVisibleCases + 10]!, 0.5, "reversed"));
    cases.push(aiCase(heldOutKeys[AI_KNOB.minHeldOutCases + 6]!, 0.5, "reversed"));
    expect(evaluateKnobDrift(AI_KNOB, cases)).toBeNull();
  });

  it("breaks an equidistant tie toward the tighter value and never considers a sub-hard-minimum candidate", () => {
    // Custom knob: live 0.875 sits exactly between candidates 0.9 and 0.85 (tie -> tighter 0.9 tried first),
    // and the 0.2 candidate below the 0.3 hard minimum must be filtered before evaluation entirely.
    const tieKnob: LoosenableKnob = {
      ...AI_KNOB,
      knobId: "tie_probe",
      candidates: [0.9, 0.85, 0.2],
      hardMinimum: 0.3,
    };
    const cases: BacktestCase[] = [];
    // 0.88-confidence REVERSED mass: live 0.875 misses them (false negatives), tighter 0.9 catches them.
    for (const key of visibleKeys.slice(0, tieKnob.minVisibleCases + 6)) cases.push(aiCase(key, 0.88, "reversed"));
    for (const key of heldOutKeys.slice(0, tieKnob.minHeldOutCases + 3)) cases.push(aiCase(key, 0.88, "reversed"));
    cases.push(aiCase(visibleKeys[tieKnob.minVisibleCases + 10]!, 0.5, "reversed"));
    cases.push(aiCase(heldOutKeys[tieKnob.minHeldOutCases + 6]!, 0.5, "reversed"));

    const report = evaluateKnobDrift(tieKnob, cases, 0.875);
    expect(report).not.toBeNull();
    expect(report!.dominatingValue).toBe(0.9); // the equidistant tie prefers the tighter alternative
    expect(report!.direction).toBe("tighter");
  });

  it("#8225: a declared tightening ladder joins the drift pool — a tighter NON-shipped candidate can now dominate from shipped", () => {
    // Reversed band at 0.94: live 0.93 misses them; the ladder's 0.95 catches them (recall up, precision
    // held) — before #8225 the pool ended at shipped, so this stale-config shape was invisible from 0.93.
    const cases: BacktestCase[] = [];
    for (const key of visibleKeys.slice(0, AI_KNOB.minVisibleCases + 6)) cases.push(aiCase(key, 0.94, "reversed"));
    for (const key of heldOutKeys.slice(0, AI_KNOB.minHeldOutCases + 3)) cases.push(aiCase(key, 0.94, "reversed"));
    cases.push(aiCase(visibleKeys[AI_KNOB.minVisibleCases + 10]!, 0.5, "reversed"));
    cases.push(aiCase(heldOutKeys[AI_KNOB.minHeldOutCases + 6]!, 0.5, "reversed"));
    const report = evaluateKnobDrift(AI_KNOB, cases);
    expect(report).not.toBeNull();
    expect(report!.direction).toBe("tighter");
    expect(report!.dominatingValue).toBe(0.95);

    // A ladder-less twin keeps the pre-#8225 pool: 0.95 is invisible, so this corpus reports nothing.
    const { tightening: _dropped, ...ladderless } = AI_KNOB;
    expect(evaluateKnobDrift(ladderless as LoosenableKnob, cases)).toBeNull();
  });

  it("is deterministic: the same corpus and live value always produce the same report", () => {
    expect(JSON.stringify(evaluateKnobDrift(AI_KNOB, aiLooseningFriendlyCorpus()))).toBe(
      JSON.stringify(evaluateKnobDrift(AI_KNOB, aiLooseningFriendlyCorpus())),
    );
  });
});

// ── #8224: the slop ceiling knob — report-only registration + orientation-aware evaluation ─────────────────

const SLOP_KNOB = LOOSENABLE_KNOBS.slop_gate_score!;

function slopCase(targetKey: string, confidence: number, label: "reversed" | "confirmed"): BacktestCase {
  return {
    ruleId: SLOP_KNOB.ruleId,
    targetKey,
    outcome: "above_threshold",
    label,
    firedAt: "2026-06-01T00:00:00.000Z",
    decidedAt: "2026-06-02T00:00:00.000Z",
    metadata: { confidence },
  };
}

const slopProbe = POOL.map((key) => slopCase(key, 0.99, "confirmed"));
const slopSplit = splitBacktestCorpus(slopProbe, SLOP_KNOB.heldOutFraction, SLOP_KNOB.splitSeed);
const slopVisibleKeys = slopSplit.visible.map((c) => c.targetKey);
const slopHeldOutKeys = slopSplit.heldOut.map((c) => c.targetKey);

// Band blocks at 0.62 the humans REVERSED (the gate over-blocked): shipped 0.60 fires them; raising the
// cap to 0.65 stops firing exactly those — precision up. A deep-high confirmed anchor per slice keeps a
// true positive on both sides of every comparison.
function slopLooseningFriendlyCorpus(): BacktestCase[] {
  const cases: BacktestCase[] = [];
  for (const key of slopVisibleKeys.slice(0, SLOP_KNOB.minVisibleCases + 6)) cases.push(slopCase(key, 0.62, "reversed"));
  for (const key of slopHeldOutKeys.slice(0, SLOP_KNOB.minHeldOutCases + 3)) cases.push(slopCase(key, 0.62, "reversed"));
  cases.push(slopCase(slopVisibleKeys[SLOP_KNOB.minVisibleCases + 10]!, 0.9, "confirmed"));
  cases.push(slopCase(slopHeldOutKeys[SLOP_KNOB.minHeldOutCases + 6]!, 0.9, "confirmed"));
  return cases;
}

describe("slop_gate_score registry entry (#8224)", () => {
  it("pins the ceiling entry: shipped from the gate constant, ascending ladder, report-only, no autonomy plumbing implied", () => {
    expect(SLOP_KNOB).toEqual({
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
    });
    expect(LOOSENABLE_KNOBS.quality_gate_score).toBeUndefined(); // stays out until a global shipped default exists
  });

  it("evaluateKnobLoosening proposes the smallest RAISE for a ceiling knob when both splits support it", () => {
    const proposal = evaluateKnobLoosening(SLOP_KNOB, slopLooseningFriendlyCorpus());
    expect(proposal).not.toBeNull();
    expect(proposal!.currentValue).toBe(0.6);
    expect(proposal!.proposedValue).toBe(0.65); // the smaller of the two raises
    expect(proposal!.visible.verdict).toBe("improved");
    expect(proposal!.heldOut.verdict).not.toBe("regressed");
  });

  it("refuses to raise past the hard maximum, even from an already-raised current value", () => {
    expect(evaluateKnobLoosening(SLOP_KNOB, slopLooseningFriendlyCorpus(), SLOP_KNOB.hardMaximum!)).toBeNull();
  });

  it("never proposes on a sample below the knob's floors", () => {
    expect(evaluateKnobLoosening(SLOP_KNOB, slopLooseningFriendlyCorpus().slice(0, 10))).toBeNull();
  });

  it("drift labels are orientation-aware: an ABOVE-live dominating alternative reads LOOSER for a ceiling knob (and is suppressible)", () => {
    const report = evaluateKnobDrift(SLOP_KNOB, slopLooseningFriendlyCorpus());
    expect(report).not.toBeNull();
    expect(report!.dominatingValue).toBe(0.65);
    expect(report!.direction).toBe("looser"); // a floor knob would have labeled the same move "tighter"
  });

  it("DEFENSIVE: a ceiling knob missing its hardMaximum can never loosen and its drift pool collapses to at-or-below shipped", () => {
    // The structural invariant forbids this shape in the shipped registry; the evaluators still refuse
    // rather than treat an absent bound as infinity.
    const { hardMaximum: _dropped, ...rest } = SLOP_KNOB;
    const unbounded = rest as LoosenableKnob;
    expect(evaluateKnobLoosening(unbounded, slopLooseningFriendlyCorpus())).toBeNull();
    const report = evaluateKnobDrift(unbounded, slopLooseningFriendlyCorpus());
    expect(report).toBeNull(); // every above-shipped alternative is filtered out; shipped === live
  });

  it("the generic report-only proposals path picks the slop knob up with zero new plumbing", async () => {
    const proposals = await loadReportOnlyKnobProposalsForTest();
    expect(proposals.some((proposal) => proposal.knobId === "slop_gate_score")).toBe(true);
  });
});

// Seed a friendly corpus into a real signal store and run the SHIPPED default-registry path — the exact
// call selftune-wire makes each pass.
async function loadReportOnlyKnobProposalsForTest() {
  const { createTestEnv } = await import("../helpers/d1");
  const { createSignalStore } = await import("../../src/review/signal-tracking-wire");
  const { loadReportOnlyKnobProposals } = await import("../../src/services/satisfaction-floor-loosening-run");
  const env = createTestEnv();
  const store = createSignalStore(env);
  const now = Date.now();
  for (const [i, backtestCase] of slopLooseningFriendlyCorpus().entries()) {
    await store.recordRuleFired({
      ruleId: SLOP_KNOB.ruleId,
      targetKey: backtestCase.targetKey,
      outcome: "above_threshold",
      occurredAt: new Date(now - 10_000 - i).toISOString(),
      metadata: { confidence: backtestCase.metadata!.confidence as number },
    });
    await store.recordHumanOverride({
      ruleId: SLOP_KNOB.ruleId,
      targetKey: backtestCase.targetKey,
      verdict: backtestCase.label,
      occurredAt: new Date(now - i).toISOString(),
    });
  }
  return loadReportOnlyKnobProposals(env, now);
}
