// Phase 7 calibration runner (#4248): the miner-side runner that finally CONNECTS the two finished-but-unwired
// halves #3014 left apart. #3014 landed the engine's pure calibration *combine* contract
// (`computePhase7CalibrationLoop`, packages/loopover-engine/src/phase7-calibration-loop.ts) and #3012 landed the
// deterministic replay *scorer* (`computeObjectiveAnchor`, ./replay-objective-anchor.js), but nothing ever called
// one with the other -- #3014's issue claimed "wired" while only the engine side shipped. This module is the
// missing runner: it scores a completed historical-replay run with the objective-anchor scorer, folds the
// resulting composite into the `HistoricalReplayCalibrationInput` shape the engine expects, calls the combine with
// the existing pr_outcome signal, and PERSISTS the combined snapshot to the local append-only event ledger (a typed
// event layered on event-ledger.js exactly like pr-outcome.js's MINER_PR_OUTCOME_EVENT), queryable via
// `gittensory-miner ledger list --type calibration_snapshot`.
//
// SCOPE: this runner is read/measure-only. It produces and persists the tracked calibration metric; it NEVER acts
// on it (no autonomy-level bump, no gate-threshold tune) -- that enforcement is maintainer-only and fail-closed
// (see docs/miner-selfimprove-calibration.md's maintainer-only boundary). The engine owns the deterministic
// combine/freshness/threshold/hold-reason logic; this module owns scheduling the score and persisting the row.

import { computePhase7CalibrationLoop } from "@loopover/engine";
import { computeObjectiveAnchor } from "./replay-objective-anchor.js";

/** Event-ledger vocabulary for a persisted Phase 7 calibration snapshot (mirrors MINER_PR_OUTCOME_EVENT). */
export const MINER_CALIBRATION_SNAPSHOT_EVENT = "calibration_snapshot";

const SCORE_PRECISION = 1e6;

function roundScore(value) {
  return Math.round(Math.min(1, Math.max(0, value)) * SCORE_PRECISION) / SCORE_PRECISION;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function numberOrNull(value) {
  return isFiniteNumber(value) ? value : null;
}

function optionalString(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Score a completed replay run's per-task results with the deterministic objective-anchor scorer and reduce them to
 * one composite `[0, 1]` accuracy (the mean of the per-task scores). `replayResults` is a list of
 * `{ replayPlan, revealedHistory }` pairs; each non-object entry is defensively skipped. Returns `compositeScore:
 * null` (never a fabricated 0) when there is no scorable task. Pure aside from the injected scorer.
 */
export function scoreHistoricalReplayComposite(replayResults, options = {}) {
  const scoreOne = options.computeObjectiveAnchor ?? computeObjectiveAnchor;
  const list = Array.isArray(replayResults) ? replayResults : [];
  const scores = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { score } = scoreOne({ replayPlan: entry.replayPlan, revealedHistory: entry.revealedHistory });
    if (isFiniteNumber(score)) scores.push(score);
  }
  const sampleSize = scores.length;
  const compositeScore = sampleSize === 0 ? null : roundScore(scores.reduce((sum, s) => sum + s, 0) / sampleSize);
  return { compositeScore, sampleSize, scores };
}

/**
 * Build the engine's `HistoricalReplayCalibrationInput` from a replay run descriptor
 * (`{ replayResults, replayRunId, observedAt, harnessStatus }`). Returns `historicalReplay: null` when no run
 * descriptor is supplied (the engine then holds `no_historical_replay_signal` when the loop is enabled). When a run
 * IS supplied its `harnessStatus` flows through verbatim so a degraded/unavailable harness still reaches the
 * engine's fail-closed hold path even if it scored zero tasks; a null composite becomes `0` only for the engine's
 * numeric contract (the un-fabricated `compositeScore`/`sampleSize` are returned alongside for the snapshot).
 */
export function buildHistoricalReplayCalibrationInput(replayRun, options = {}) {
  if (!replayRun || typeof replayRun !== "object" || Array.isArray(replayRun)) {
    return { historicalReplay: null, compositeScore: null, sampleSize: 0, scores: [] };
  }
  const composite = scoreHistoricalReplayComposite(replayRun.replayResults, options);
  return {
    historicalReplay: {
      compositeScore: composite.compositeScore ?? 0,
      replayRunId: replayRun.replayRunId,
      observedAt: replayRun.observedAt,
      harnessStatus: replayRun.harnessStatus,
    },
    compositeScore: composite.compositeScore,
    sampleSize: composite.sampleSize,
    scores: composite.scores,
  };
}

/**
 * Derive a JSON-safe, public-safe snapshot payload from a computed `Phase7CalibrationLoopResult`. Only accuracies,
 * the documented baseline, hold-reason CODES, and provenance are surfaced -- never raw replay scores or rewards.
 * Every field is a number/null, boolean, string/null, or string[] so it round-trips through the event ledger's
 * verbatim-JSON serializer unchanged.
 */
export function snapshotPayloadFromResult(result, meta = {}) {
  return {
    enabled: result.enabled === true,
    combinedAccuracy: numberOrNull(result.combinedAccuracy),
    baselineAccuracy: isFiniteNumber(result.baselineAccuracy) ? result.baselineAccuracy : 0,
    deltaFromBaseline: numberOrNull(result.deltaFromBaseline),
    autonomyIncreasePermitted: result.autonomyIncreasePermitted === true,
    replayHarnessHold: result.replayHarnessHold === true,
    replayHarnessStatus: optionalString(result.replayHarnessStatus) ?? "missing",
    replayRunDue: result.replayRunDue === true,
    holdReasons: Array.isArray(result.holdReasons) ? result.holdReasons.map(String) : [],
    contributingSources: Array.isArray(result.audit?.contributingSources)
      ? result.audit.contributingSources.map(String)
      : [],
    replayRunId: optionalString(meta.replayRunId),
    observedAt: optionalString(meta.observedAt),
    replaySampleSize: Number.isInteger(meta.sampleSize) && meta.sampleSize >= 0 ? meta.sampleSize : 0,
  };
}

/**
 * Validate + normalize a calibration-snapshot payload, returning `null` on any malformed shape (mirrors
 * pr-outcome.js's `normalizePrOutcomePayload`, so a corrupted row can neither be written nor read back). Skipped
 * rows are dropped by the reader rather than throwing.
 */
export function normalizeCalibrationSnapshotPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  if (payload.combinedAccuracy !== null && !isFiniteNumber(payload.combinedAccuracy)) return null;
  if (!isFiniteNumber(payload.baselineAccuracy)) return null;
  if (payload.deltaFromBaseline !== null && !isFiniteNumber(payload.deltaFromBaseline)) return null;
  if (typeof payload.autonomyIncreasePermitted !== "boolean") return null;
  const replayHarnessStatus = optionalString(payload.replayHarnessStatus);
  if (!replayHarnessStatus) return null;
  if (!Array.isArray(payload.holdReasons) || payload.holdReasons.some((code) => typeof code !== "string")) {
    return null;
  }
  const contributingSources = Array.isArray(payload.contributingSources)
    ? payload.contributingSources.filter((code) => typeof code === "string")
    : [];
  return {
    enabled: payload.enabled === true,
    combinedAccuracy: payload.combinedAccuracy,
    baselineAccuracy: payload.baselineAccuracy,
    deltaFromBaseline: payload.deltaFromBaseline,
    autonomyIncreasePermitted: payload.autonomyIncreasePermitted,
    replayHarnessHold: payload.replayHarnessHold === true,
    replayHarnessStatus,
    replayRunDue: payload.replayRunDue === true,
    holdReasons: payload.holdReasons,
    contributingSources,
    replayRunId: optionalString(payload.replayRunId),
    observedAt: optionalString(payload.observedAt),
    replaySampleSize:
      Number.isInteger(payload.replaySampleSize) && payload.replaySampleSize >= 0 ? payload.replaySampleSize : 0,
  };
}

/**
 * Persist one calibration snapshot to an INJECTED event ledger (same dependency-injection shape as pr-outcome.js's
 * `recordPrOutcomeSnapshot`, so it's unit-testable without a real SQLite file). Fail-soft: a malformed payload
 * returns `null` without appending. An unusable ledger is the only hard error (a programmer wiring mistake).
 */
export function recordCalibrationSnapshot(input, options = {}) {
  const eventLedger = options.eventLedger;
  if (!eventLedger || typeof eventLedger.appendEvent !== "function") throw new Error("invalid_event_ledger");
  const payload = normalizeCalibrationSnapshotPayload(input);
  if (!payload) return null;
  const repoFullName = optionalString(options.repoFullName);
  return eventLedger.appendEvent({
    type: MINER_CALIBRATION_SNAPSHOT_EVENT,
    ...(repoFullName ? { repoFullName } : {}),
    payload,
  });
}

/**
 * Read every persisted calibration snapshot from the injected ledger's ascending append-only stream (mirrors
 * pr-outcome.js's `readPrOutcomes`). Foreign event types and malformed payloads are skipped; a ledger that cannot
 * read reduces to an empty list. Returns snapshots in ledger order (oldest first).
 */
export function readCalibrationSnapshots(eventLedger, filter = {}) {
  const events =
    eventLedger && typeof eventLedger.readEvents === "function" ? eventLedger.readEvents(filter) : [];
  const snapshots = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== MINER_CALIBRATION_SNAPSHOT_EVENT) continue;
    const normalized = normalizeCalibrationSnapshotPayload(event.payload);
    if (!normalized) continue;
    snapshots.push({
      ...normalized,
      repoFullName: typeof event.repoFullName === "string" ? event.repoFullName : null,
      seq: Number.isInteger(event.seq) ? event.seq : null,
      createdAt: optionalString(event.createdAt),
    });
  }
  return snapshots;
}

/** The most recent persisted calibration snapshot, or `null` when none exist. */
export function latestCalibrationSnapshot(eventLedger, filter = {}) {
  const snapshots = readCalibrationSnapshots(eventLedger, filter);
  return snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
}

/**
 * The runner. Scores the replay run (via the objective-anchor scorer), calls the engine's calibration combine with
 * the resulting historical-replay composite plus the existing pr_outcome signal, and -- when an event ledger is
 * injected -- persists the combined snapshot. Returns the engine result, the derived snapshot payload, the recorded
 * ledger entry (or null when no ledger was injected or the payload was malformed), and the un-fabricated
 * composite/sample provenance. The engine combine (`computeLoop`) is injectable so unit tests can pin it.
 */
export function runHistoricalReplayCalibrationCycle(input = {}, deps = {}) {
  const computeLoop = deps.computeLoop ?? computePhase7CalibrationLoop;
  const built = buildHistoricalReplayCalibrationInput(input.replayRun, deps);
  const result = computeLoop({
    config: input.config,
    prOutcome: input.prOutcome,
    historicalReplay: built.historicalReplay,
    now: input.now,
  });
  const snapshot = snapshotPayloadFromResult(result, {
    replayRunId: built.historicalReplay?.replayRunId ?? null,
    observedAt: input.observedAt ?? built.historicalReplay?.observedAt ?? null,
    sampleSize: built.sampleSize,
  });
  const recorded = deps.eventLedger
    ? recordCalibrationSnapshot(snapshot, { eventLedger: deps.eventLedger, repoFullName: input.repoFullName })
    : null;
  return {
    result,
    snapshot,
    recorded,
    historicalReplay: built.historicalReplay,
    compositeScore: built.compositeScore,
    sampleSize: built.sampleSize,
    scores: built.scores,
  };
}
