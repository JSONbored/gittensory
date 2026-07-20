// Shared SqliteDriver / D1 adapter seam for AMS local stores (#7175 part 1).
//
// Mirrors ORB's `src/selfhost/d1-adapter.ts` so hosted AMS can later swap in `createPgAdapter` without
// inventing a second abstraction. Self-host default remains node:sqlite via `nodeSqliteDriver`.
// Keep this surface in sync with the ORB module when either side grows (Postgres interactive txn /
// `runOn` arrives in a later #7175 slice — not this file yet).

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/** Sync SQLite primitive both node:sqlite and (later) Postgres-backed drivers satisfy (#7175). */
export interface SqliteDriver {
  query(
    sql: string,
    params: unknown[],
  ): { rows: Record<string, unknown>[]; changes: number; lastInsertRowid: number };
  exec(sql: string): void;
}

/** Minimal D1-shaped surface returned by `createD1Adapter` (async wrappers over SqliteDriver). */
export interface MinerD1Database {
  prepare(sql: string): MinerD1PreparedStatement;
  batch(statements: MinerD1PreparedStatement[]): Promise<unknown[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
  dump(): Promise<ArrayBuffer>;
}

export interface MinerD1PreparedStatement {
  bind(...values: unknown[]): MinerD1PreparedStatement;
  all<T = unknown>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }>;
  run<T = unknown>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }>;
  first<T = unknown>(colName?: string): Promise<T | null>;
  raw<T = unknown>(): Promise<T[]>;
}

function meta(changes = 0, lastRowId = 0) {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: changes,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    changes,
  };
}

/** One prepared (and optionally bound) statement — D1 statements are immutable after bind. */
class Statement {
  declare driver: SqliteDriver;
  declare sql: string;
  declare values: unknown[];

  constructor(driver: SqliteDriver, sql: string, values: unknown[] = []) {
    this.driver = driver;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: unknown[]): Statement {
    return new Statement(this.driver, this.sql, values);
  }

  execSync(): { results: unknown[]; success: true; meta: Record<string, unknown> } {
    const r = this.driver.query(this.sql, this.values);
    return { results: r.rows, success: true, meta: meta(r.changes, r.lastInsertRowid) };
  }

  async all<T = unknown>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    return this.execSync() as { results: T[]; success: true; meta: Record<string, unknown> };
  }

  async run<T = unknown>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> {
    return this.execSync() as { results: T[]; success: true; meta: Record<string, unknown> };
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const row = this.driver.query(this.sql, this.values).rows[0];
    if (row == null) return null;
    return ((colName != null ? row[colName] : row) ?? null) as T | null;
  }

  async raw<T = unknown>(): Promise<T[]> {
    return this.driver.query(this.sql, this.values).rows.map((row) => Object.values(row)) as T[];
  }
}

/**
 * Wrap a synchronous SqliteDriver as a D1-shaped database (async prepare/batch/exec).
 */
export function createD1Adapter(driver: SqliteDriver): MinerD1Database {
  return {
    prepare(sql: string) {
      return new Statement(driver, sql);
    },
    async batch(statements: Statement[]) {
      driver.exec("BEGIN");
      try {
        const out = statements.map((s) => s.execSync());
        driver.exec("COMMIT");
        return out;
      } catch (error) {
        try {
          driver.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw error;
      }
    },
    async exec(sql: string) {
      driver.exec(sql);
      return { count: (sql.match(/;/g) ?? []).length || 1, duration: 0 };
    },
    async dump() {
      return new ArrayBuffer(0);
    },
  };
}

/**
 * Build a SqliteDriver from a node:sqlite DatabaseSync.
 * A statement with zero result columns is a WRITE; otherwise a READ.
 *
 * LIMITATION (#7175 follow-up): `INSERT/UPDATE/DELETE … RETURNING` statements report result columns, so
 * this heuristic would treat them as reads and drop `changes`/`lastInsertRowid`. claim-ledger and other
 * RETURNING callers must not migrate onto `driver.query` until the heuristic is sharpened (e.g. statement
 * class detection) or those stores use `createD1Adapter`/`run` exclusively.
 */
export function nodeSqliteDriver(db: DatabaseSync): SqliteDriver {
  return {
    query(sql, params) {
      const stmt = db.prepare(sql);
      if (stmt.columns().length > 0) {
        return { rows: stmt.all(...(params as SQLInputValue[])), changes: 0, lastInsertRowid: 0 };
      }
      const info = stmt.run(...(params as SQLInputValue[]));
      return { rows: [], changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
    },
    exec(sql) {
      db.exec(sql);
    },
  };
}
