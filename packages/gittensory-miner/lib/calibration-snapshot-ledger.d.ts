export type CalibrationAccuracySnapshot = {
  observedAt: string;
  combinedAccuracy: number | null;
  deltaFromBaseline?: number | null;
};

export type CalibrationSnapshotRow = {
  id: number;
  observedAt: string;
  combinedAccuracy: number | null;
  deltaFromBaseline: number | null;
  engineVersion: string;
};

export type CalibrationSnapshotLedger = {
  dbPath: string;
  appendSnapshot(input: {
    observedAt?: string;
    combinedAccuracy?: number | null;
    deltaFromBaseline?: number | null;
    engineVersion?: string;
  }): CalibrationSnapshotRow;
  readSnapshots(): CalibrationSnapshotRow[];
  close(): void;
};

export function resolveCalibrationSnapshotLedgerDbPath(env?: Record<string, string | undefined>): string;

export function initCalibrationSnapshotLedger(dbPath?: string): CalibrationSnapshotLedger;

export function appendCalibrationSnapshot(input: {
  observedAt?: string;
  combinedAccuracy?: number | null;
  deltaFromBaseline?: number | null;
  engineVersion?: string;
}): CalibrationSnapshotRow;

export function readCalibrationSnapshots(): CalibrationSnapshotRow[];

export function closeCalibrationSnapshotLedger(): void;

export function toCalibrationAccuracySnapshots(rows: CalibrationSnapshotRow[]): CalibrationAccuracySnapshot[];
