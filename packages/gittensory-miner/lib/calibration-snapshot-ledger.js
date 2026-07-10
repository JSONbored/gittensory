import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Append-only calibration snapshot ledger (#4268). Stores periodic combined-accuracy readings from
// Phase7CalibrationLoopResult so the extension trend panel and miner CLI can chart accuracy over time.
// INSERT + SELECT only — never UPDATE/DELETE.

const defaultDbFileName = "calibration-snapshot-ledger.sqlite3";
let defaultCalibrationSnapshotLedger = null;

export function resolveCalibrationSnapshotLedgerDbPath(env = process.env) {
  const explicitPath = typeof env.GITTENSORY_MINER_CALIBRATION_SNAPSHOT_DB === "string"
    ? env.GITTENSORY_MINER_CALIBRATION_SNAPSHOT_DB.trim()
    : "";
  if (explicitPath) return explicitPath;

  const explicitConfigDir = typeof env.GITTENSORY_MINER_CONFIG_DIR === "string"
    ? env.GITTENSORY_MINER_CONFIG_DIR.trim()
    : "";
  if (explicitConfigDir) return join(explicitConfigDir, defaultDbFileName);

  const configHome = typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
    ? env.XDG_CONFIG_HOME.trim()
    : join(homedir(), ".config");
  return join(configHome, "gittensory-miner", defaultDbFileName);
}

function normalizeDbPath(dbPath) {
  const path = (dbPath ?? resolveCalibrationSnapshotLedgerDbPath()).trim();
  if (!path) throw new Error("invalid_calibration_snapshot_ledger_db_path");
  return path;
}

function normalizeCombinedAccuracy(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid_combined_accuracy");
  return value;
}

function normalizeDeltaFromBaseline(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid_delta_from_baseline");
  return value;
}

function normalizeSnapshotInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_calibration_snapshot_input");
  const observedAt = typeof input.observedAt === "string" && input.observedAt.trim()
    ? input.observedAt.trim()
    : new Date().toISOString();
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error("invalid_observed_at");
  return {
    observedAt,
    combinedAccuracy: normalizeCombinedAccuracy(input.combinedAccuracy),
    deltaFromBaseline: normalizeDeltaFromBaseline(input.deltaFromBaseline),
    engineVersion: typeof input.engineVersion === "string" && input.engineVersion.trim()
      ? input.engineVersion.trim()
      : "unknown",
  };
}

function rowToSnapshot(row) {
  return {
    id: row.id,
    observedAt: row.observed_at,
    combinedAccuracy: row.combined_accuracy,
    deltaFromBaseline: row.delta_from_baseline,
    engineVersion: row.engine_version,
  };
}

/** Opens the append-only calibration snapshot ledger, creating the table on first use. */
export function initCalibrationSnapshotLedger(dbPath = resolveCalibrationSnapshotLedgerDbPath()) {
  const resolvedPath = normalizeDbPath(dbPath);
  mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolvedPath);
  chmodSync(resolvedPath, 0o600);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS calibration_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observed_at TEXT NOT NULL,
      combined_accuracy REAL,
      delta_from_baseline REAL,
      engine_version TEXT NOT NULL
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_calibration_snapshots_observed_at ON calibration_snapshots (observed_at)");

  const appendStatement = db.prepare(`
    INSERT INTO calibration_snapshots (observed_at, combined_accuracy, delta_from_baseline, engine_version)
    VALUES (?, ?, ?, ?)
  `);
  const readAllStatement = db.prepare("SELECT * FROM calibration_snapshots ORDER BY observed_at ASC, id ASC");

  return {
    dbPath: resolvedPath,
    appendSnapshot(input) {
      const snapshot = normalizeSnapshotInput(input);
      const result = appendStatement.run(
        snapshot.observedAt,
        snapshot.combinedAccuracy,
        snapshot.deltaFromBaseline,
        snapshot.engineVersion,
      );
      return rowToSnapshot(db.prepare("SELECT * FROM calibration_snapshots WHERE id = ?").get(Number(result.lastInsertRowid)));
    },
    readSnapshots() {
      return readAllStatement.all().map(rowToSnapshot);
    },
    close() {
      db.close();
    },
  };
}

function getDefaultCalibrationSnapshotLedger() {
  defaultCalibrationSnapshotLedger ??= initCalibrationSnapshotLedger();
  return defaultCalibrationSnapshotLedger;
}

export function appendCalibrationSnapshot(input) {
  return getDefaultCalibrationSnapshotLedger().appendSnapshot(input);
}

export function readCalibrationSnapshots() {
  return getDefaultCalibrationSnapshotLedger().readSnapshots();
}

export function closeCalibrationSnapshotLedger() {
  if (defaultCalibrationSnapshotLedger) {
    defaultCalibrationSnapshotLedger.close();
    defaultCalibrationSnapshotLedger = null;
  }
}

/** Shape consumed by buildCalibrationAccuracyTrendView in @jsonbored/gittensory-engine. */
export function toCalibrationAccuracySnapshots(rows) {
  return rows.map((row) => ({
    observedAt: row.observedAt,
    combinedAccuracy: row.combinedAccuracy,
    deltaFromBaseline: row.deltaFromBaseline,
  }));
}
