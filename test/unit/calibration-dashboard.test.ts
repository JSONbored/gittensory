import { describe, expect, it } from "vitest";
import { renderCalibrationDashboard } from "../../packages/gittensory-engine/src/calibration-dashboard";
import { computePhase7CalibrationLoop, resolvePhase7CalibrationConfig } from "../../packages/gittensory-engine/src/phase7-calibration-loop";
import type { CalibrationSourceMetric, Phase7CalibrationLoopResult } from "../../packages/gittensory-engine/src/phase7-calibration-loop";

const source = (over: Partial<CalibrationSourceMetric>): CalibrationSourceMetric => ({
  source: "pr_outcome",
  accuracy: 0.74,
  sampleSize: 100,
  observedAt: "2026-07-04T12:00:00.000Z",
  fresh: true,
  ...over,
});

const makeResult = (over: Partial<Phase7CalibrationLoopResult> = {}): Phase7CalibrationLoopResult => ({
  enabled: true,
  baselineAccuracy: 0.62,
  combinedAccuracy: 0.78,
  deltaFromBaseline: 0.16,
  weights: { historicalReplay: 0.5, prOutcome: 0.5 },
  bySource: {
    historical_replay: source({ source: "historical_replay", accuracy: 0.82, replayRunId: "r1", harnessStatus: "healthy" }),
    pr_outcome: source({ source: "pr_outcome", accuracy: 0.74 }),
  },
  replayHarnessHold: false,
  replayHarnessStatus: "healthy",
  autonomyIncreasePermitted: true,
  holdReasons: [],
  replayRunDue: false,
  audit: { contributingSources: ["historical_replay", "pr_outcome"], rejectedSources: [] },
  ...over,
});

describe("renderCalibrationDashboard (#4261)", () => {
  it("renders a healthy result above baseline with a positive delta and per-source freshness", () => {
    const out = renderCalibrationDashboard(makeResult());
    expect(out).toContain("combined accuracy: 78% vs 62% baseline (+16pp)");
    expect(out).toContain("historical_replay: 82% (n=100, fresh)");
    expect(out).toContain("pr_outcome: 74% (n=100, fresh)");
    expect(out).toContain("replay harness: healthy");
    expect(out).not.toContain("replay run due");
    expect(out).not.toContain("holds:");
  });

  it("renders a degraded result below baseline with a negative delta (no + sign)", () => {
    const out = renderCalibrationDashboard(makeResult({ combinedAccuracy: 0.5, deltaFromBaseline: -0.12 }));
    expect(out).toContain("combined accuracy: 50% vs 62% baseline (-12pp)");
  });

  it("renders the no-data state clearly instead of a fake 0%, showing '—' for absent sources, a due run, and holds", () => {
    const out = renderCalibrationDashboard(
      makeResult({
        combinedAccuracy: null,
        deltaFromBaseline: null,
        bySource: {
          historical_replay: source({ source: "historical_replay", accuracy: null, sampleSize: 0, observedAt: null, fresh: false }),
          pr_outcome: source({ source: "pr_outcome", accuracy: null, sampleSize: 0, observedAt: null, fresh: false }),
        },
        replayHarnessStatus: "missing",
        replayRunDue: true,
        holdReasons: ["insufficient_data", "replay_harness_unavailable"],
      }),
    );
    expect(out).toContain("no data yet");
    expect(out).not.toMatch(/combined accuracy: \d/); // never a numeric 0%
    expect(out).toContain("historical_replay: — (n=0, stale)");
    expect(out).toContain("replay harness: missing — replay run due");
    expect(out).toContain("holds: insufficient_data; replay_harness_unavailable");
  });

  it("integrates with a real computePhase7CalibrationLoop result (fixture inputs)", () => {
    const result = computePhase7CalibrationLoop({
      config: resolvePhase7CalibrationConfig({
        miner: { calibration: { phase7LoopEnabled: true, autonomyIncreaseMinAccuracy: 0.7, replayFreshnessMaxAgeHours: 168, historicalReplayWeight: 0.5, prOutcomeWeight: 0.5, prOutcomeMinDecided: 10 } },
      }),
      prOutcome: { mergeConfirmed: 74, mergeFalse: 26, closeConfirmed: 0, closeFalse: 0, observedAt: "2026-07-04T18:00:00Z" },
      historicalReplay: { compositeScore: 0.82, replayRunId: "replay-2026-07-04", observedAt: "2026-07-04T12:00:00Z", harnessStatus: "healthy" },
      now: "2026-07-04T18:00:00Z",
    });
    const out = renderCalibrationDashboard(result);
    expect(out).toContain("Phase 7 self-review calibration");
    expect(out).toContain("combined accuracy:");
    expect(out).toContain("pr_outcome: 74%");
  });
});
