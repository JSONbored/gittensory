import type {
  HistoricalReplayCalibrationInput,
  Phase7CalibrationConfig,
  Phase7CalibrationLoopResult,
  Phase7CalibrationManifest,
  PrOutcomeCalibrationInput,
  ReplayHarnessStatus,
} from "@loopover/engine";

import type { AppendEventInput, LedgerEntry } from "./event-ledger.js";
import type {
  ObjectiveAnchorResult,
  ReplayPlanInput,
  RevealedHistoryEntry,
} from "./replay-objective-anchor.js";

export const MINER_CALIBRATION_SNAPSHOT_EVENT: "calibration_snapshot";

/** One completed replay-run task result: what the replay targeted, and the revealed post-T history to score it. */
export interface ReplayTaskResult {
  replayPlan?: ReplayPlanInput | null;
  revealedHistory?: RevealedHistoryEntry[] | RevealedHistoryEntry | null;
}

export interface ScoreCompositeOptions {
  computeObjectiveAnchor?: (
    input: { replayPlan?: ReplayPlanInput | null; revealedHistory?: RevealedHistoryEntry[] | RevealedHistoryEntry | null },
  ) => ObjectiveAnchorResult;
}

export interface HistoricalReplayCompositeScore {
  compositeScore: number | null;
  sampleSize: number;
  scores: number[];
}

export function scoreHistoricalReplayComposite(
  replayResults: readonly ReplayTaskResult[] | null | undefined,
  options?: ScoreCompositeOptions,
): HistoricalReplayCompositeScore;

/** A completed replay run's descriptor: its per-task results plus the run's identity/freshness/harness health. */
export interface ReplayRunDescriptor {
  replayResults?: readonly ReplayTaskResult[] | null;
  replayRunId?: string;
  observedAt?: string;
  harnessStatus?: ReplayHarnessStatus;
}

export interface BuiltHistoricalReplayInput {
  historicalReplay: HistoricalReplayCalibrationInput | null;
  compositeScore: number | null;
  sampleSize: number;
  scores: number[];
}

export function buildHistoricalReplayCalibrationInput(
  replayRun: ReplayRunDescriptor | null | undefined,
  options?: ScoreCompositeOptions,
): BuiltHistoricalReplayInput;

/** The persisted, public-safe projection of a Phase7CalibrationLoopResult. */
export interface CalibrationSnapshotPayload {
  enabled: boolean;
  combinedAccuracy: number | null;
  baselineAccuracy: number;
  deltaFromBaseline: number | null;
  autonomyIncreasePermitted: boolean;
  replayHarnessHold: boolean;
  replayHarnessStatus: string;
  replayRunDue: boolean;
  holdReasons: string[];
  contributingSources: string[];
  replayRunId: string | null;
  observedAt: string | null;
  replaySampleSize: number;
}

export interface SnapshotMeta {
  replayRunId?: string | null;
  observedAt?: string | null;
  sampleSize?: number;
}

export function snapshotPayloadFromResult(
  result: Phase7CalibrationLoopResult,
  meta?: SnapshotMeta,
): CalibrationSnapshotPayload;

export function normalizeCalibrationSnapshotPayload(payload: unknown): CalibrationSnapshotPayload | null;

export interface RecordCalibrationSnapshotOptions {
  /** Optional at the type level so a caller can pass an unusable ledger to exercise the fail-closed guard; the
   *  writer throws `invalid_event_ledger` at runtime when this is absent or lacks `appendEvent`. */
  eventLedger?: { appendEvent(event: AppendEventInput): LedgerEntry };
  repoFullName?: string;
}

export function recordCalibrationSnapshot(
  input: unknown,
  options?: RecordCalibrationSnapshotOptions,
): LedgerEntry | null;

export interface CalibrationSnapshotReader {
  readEvents(filter?: { since?: number | null; repoFullName?: string | null }): unknown[];
}

export interface CalibrationSnapshotFilter {
  since?: number | null;
  repoFullName?: string | null;
}

export interface PersistedCalibrationSnapshot extends CalibrationSnapshotPayload {
  repoFullName: string | null;
  seq: number | null;
  createdAt: string | null;
}

export function readCalibrationSnapshots(
  eventLedger: CalibrationSnapshotReader,
  filter?: CalibrationSnapshotFilter,
): PersistedCalibrationSnapshot[];

export function latestCalibrationSnapshot(
  eventLedger: CalibrationSnapshotReader,
  filter?: CalibrationSnapshotFilter,
): PersistedCalibrationSnapshot | null;

export interface RunCalibrationCycleInput {
  config?: Phase7CalibrationConfig | Phase7CalibrationManifest | Record<string, unknown> | null;
  prOutcome?: PrOutcomeCalibrationInput | null;
  replayRun?: ReplayRunDescriptor | null;
  now?: string | Date | null;
  observedAt?: string | null;
  repoFullName?: string;
}

export interface RunCalibrationCycleDeps extends ScoreCompositeOptions {
  computeLoop?: (input: {
    config?: Phase7CalibrationConfig | Phase7CalibrationManifest | Record<string, unknown> | null;
    prOutcome?: PrOutcomeCalibrationInput | null;
    historicalReplay?: HistoricalReplayCalibrationInput | null;
    now?: string | Date | null;
  }) => Phase7CalibrationLoopResult;
  eventLedger?: { appendEvent(event: AppendEventInput): LedgerEntry };
}

export interface RunCalibrationCycleResult {
  result: Phase7CalibrationLoopResult;
  snapshot: CalibrationSnapshotPayload;
  recorded: LedgerEntry | null;
  historicalReplay: HistoricalReplayCalibrationInput | null;
  compositeScore: number | null;
  sampleSize: number;
  scores: number[];
}

export function runHistoricalReplayCalibrationCycle(
  input?: RunCalibrationCycleInput,
  deps?: RunCalibrationCycleDeps,
): RunCalibrationCycleResult;
