import { formatAttemptLogJsonl, normalizeAttemptLogEvent } from "@loopover/engine";
import { normalizeLocalStoreDbPath, openLocalStoreDb, resolveLocalStoreDbPath } from "./local-store.js";
const defaultDbFileName = "attempt-log.sqlite3";
let defaultAttemptLog = null;
export function resolveAttemptLogDbPath(env = process.env) {
    return resolveLocalStoreDbPath(defaultDbFileName, "LOOPOVER_MINER_ATTEMPT_LOG_DB", env);
}
function normalizeDbPath(dbPath) {
    return normalizeLocalStoreDbPath(dbPath, resolveAttemptLogDbPath(), "invalid_attempt_log_db_path");
}
/** Read-filter attempt scope: omitted/nullish → unscoped (all events); otherwise a non-empty attempt id. */
function normalizeReadAttemptIdFilter(attemptId) {
    if (attemptId === undefined || attemptId === null)
        return undefined;
    if (typeof attemptId !== "string")
        throw new Error("invalid_attempt_id");
    const trimmed = attemptId.trim();
    if (!trimmed)
        throw new Error("invalid_attempt_id");
    return trimmed;
}
/** Export requires an explicit attempt id — JSONL dumps are always per attempt. */
function normalizeRequiredAttemptId(attemptId) {
    const normalized = normalizeReadAttemptIdFilter(attemptId);
    if (normalized === undefined)
        throw new Error("invalid_attempt_id");
    return normalized;
}
function rowToEntry(row) {
    let payload;
    try {
        payload = JSON.parse(row.payload_json);
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
            throw new Error("corrupted_attempt_log_row");
        }
    }
    catch {
        throw new Error("corrupted_attempt_log_row");
    }
    return {
        id: row.id,
        seq: row.seq,
        eventType: row.event_type,
        attemptId: row.attempt_id,
        actionClass: row.action_class,
        mode: row.mode,
        reason: row.reason,
        payload: payload,
        provider: row.provider,
        costUsd: row.cost_usd,
        tokensUsed: row.tokens_used,
        createdAt: row.created_at,
    };
}
function rowToNormalized(row) {
    return {
        eventType: row.event_type,
        attemptId: row.attempt_id,
        actionClass: row.action_class,
        mode: row.mode,
        reason: row.reason,
        payloadJson: row.payload_json,
        provider: row.provider,
        costUsd: row.cost_usd,
        tokensUsed: row.tokens_used,
    };
}
// Add the provider/cost_usd/tokens_used columns (#5185) to an on-disk file created before they existed. `CREATE
// TABLE IF NOT EXISTS` above is a no-op against an already-existing table, so a pre-#5185 file needs this
// explicit ALTER -- guarded by a per-column presence check (same technique as governor-state.js's own
// ensurePauseColumns) so a file missing only one of the three still gets exactly what it's missing.
function ensureOutcomeColumns(db) {
    const existingColumns = new Set(db.prepare("PRAGMA table_info(attempt_log_events)").all().map((column) => column.name));
    if (!existingColumns.has("provider")) {
        db.exec("ALTER TABLE attempt_log_events ADD COLUMN provider TEXT");
    }
    if (!existingColumns.has("cost_usd")) {
        db.exec("ALTER TABLE attempt_log_events ADD COLUMN cost_usd REAL");
    }
    if (!existingColumns.has("tokens_used")) {
        db.exec("ALTER TABLE attempt_log_events ADD COLUMN tokens_used INTEGER");
    }
}
/**
 * Opens the append-only attempt log, creating the table on first use. `seq` is a monotonically increasing counter
 * maintained by this module (next = current MAX(seq) + 1) with a UNIQUE(seq) constraint. Rows read back in seq ASC
 * order. (#4294)
 */
export function initAttemptLog(dbPath = resolveAttemptLogDbPath()) {
    const resolvedPath = normalizeDbPath(dbPath);
    const db = openLocalStoreDb(resolvedPath);
    db.exec(`
    CREATE TABLE IF NOT EXISTS attempt_log_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seq INTEGER NOT NULL UNIQUE,
      attempt_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      action_class TEXT NOT NULL,
      mode TEXT NOT NULL,
      reason TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
    ensureOutcomeColumns(db);
    db.exec("CREATE INDEX IF NOT EXISTS idx_attempt_log_attempt ON attempt_log_events (attempt_id, seq)");
    const nextSeqStatement = db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM attempt_log_events");
    const appendStatement = db.prepare(`
    INSERT INTO attempt_log_events (
      seq, attempt_id, event_type, action_class, mode, reason, payload_json, provider, cost_usd, tokens_used,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
    const getByIdStatement = db.prepare("SELECT * FROM attempt_log_events WHERE id = ?");
    const readAllStatement = db.prepare("SELECT * FROM attempt_log_events ORDER BY seq ASC");
    const readByAttemptStatement = db.prepare("SELECT * FROM attempt_log_events WHERE attempt_id = ? ORDER BY seq ASC");
    return {
        dbPath: resolvedPath,
        appendAttemptLogEvent(event) {
            const normalized = normalizeAttemptLogEvent(event);
            const createdAt = new Date().toISOString();
            db.exec("BEGIN IMMEDIATE");
            try {
                const { nextSeq } = nextSeqStatement.get();
                const result = appendStatement.run(nextSeq, normalized.attemptId, normalized.eventType, normalized.actionClass, normalized.mode, normalized.reason, normalized.payloadJson, normalized.provider, normalized.costUsd, normalized.tokensUsed, createdAt);
                const entry = rowToEntry(getByIdStatement.get(Number(result.lastInsertRowid)));
                db.exec("COMMIT");
                return entry;
            }
            catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
        },
        readAttemptLogEvents(filter = {}) {
            const attemptId = normalizeReadAttemptIdFilter(filter.attemptId);
            const rows = attemptId === undefined
                ? readAllStatement.all()
                : readByAttemptStatement.all(attemptId);
            return rows.map(rowToEntry);
        },
        exportAttemptLogJsonl(attemptId) {
            const scopedAttemptId = normalizeRequiredAttemptId(attemptId);
            const rows = readByAttemptStatement.all(scopedAttemptId);
            return formatAttemptLogJsonl(rows.map(rowToNormalized));
        },
        close() {
            db.close();
        },
    };
}
function getDefaultAttemptLog() {
    defaultAttemptLog ??= initAttemptLog();
    return defaultAttemptLog;
}
export function appendAttemptLogEvent(event) {
    return getDefaultAttemptLog().appendAttemptLogEvent(event);
}
export function readAttemptLogEvents(filter) {
    return getDefaultAttemptLog().readAttemptLogEvents(filter);
}
export function exportAttemptLogJsonl(attemptId) {
    return getDefaultAttemptLog().exportAttemptLogJsonl(attemptId);
}
export function closeDefaultAttemptLog() {
    if (!defaultAttemptLog)
        return;
    defaultAttemptLog.close();
    defaultAttemptLog = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXR0ZW1wdC1sb2cuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhdHRlbXB0LWxvZy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFDQSxPQUFPLEVBQXdELHFCQUFxQixFQUFFLHdCQUF3QixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUFDekksT0FBTyxFQUFFLHlCQUF5QixFQUFFLGdCQUFnQixFQUFFLHVCQUF1QixFQUFFLE1BQU0sa0JBQWtCLENBQUM7QUE0RHhHLE1BQU0saUJBQWlCLEdBQUcscUJBQXFCLENBQUM7QUFDaEQsSUFBSSxpQkFBaUIsR0FBc0IsSUFBSSxDQUFDO0FBRWhELE1BQU0sVUFBVSx1QkFBdUIsQ0FBQyxNQUEwQyxPQUFPLENBQUMsR0FBRztJQUMzRixPQUFPLHVCQUF1QixDQUFDLGlCQUFpQixFQUFFLCtCQUErQixFQUFFLEdBQUcsQ0FBQyxDQUFDO0FBQzFGLENBQUM7QUFFRCxTQUFTLGVBQWUsQ0FBQyxNQUFjO0lBQ3JDLE9BQU8seUJBQXlCLENBQUMsTUFBTSxFQUFFLHVCQUF1QixFQUFFLEVBQUUsNkJBQTZCLENBQUMsQ0FBQztBQUNyRyxDQUFDO0FBRUQsNEdBQTRHO0FBQzVHLFNBQVMsNEJBQTRCLENBQUMsU0FBa0I7SUFDdEQsSUFBSSxTQUFTLEtBQUssU0FBUyxJQUFJLFNBQVMsS0FBSyxJQUFJO1FBQUUsT0FBTyxTQUFTLENBQUM7SUFDcEUsSUFBSSxPQUFPLFNBQVMsS0FBSyxRQUFRO1FBQUUsTUFBTSxJQUFJLEtBQUssQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO0lBQ3pFLE1BQU0sT0FBTyxHQUFHLFNBQVMsQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUNqQyxJQUFJLENBQUMsT0FBTztRQUFFLE1BQU0sSUFBSSxLQUFLLENBQUMsb0JBQW9CLENBQUMsQ0FBQztJQUNwRCxPQUFPLE9BQU8sQ0FBQztBQUNqQixDQUFDO0FBRUQsbUZBQW1GO0FBQ25GLFNBQVMsMEJBQTBCLENBQUMsU0FBa0I7SUFDcEQsTUFBTSxV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