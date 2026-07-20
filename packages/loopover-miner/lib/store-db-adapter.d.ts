import type { DatabaseSync } from "node:sqlite";
/** Sync SQLite primitive both node:sqlite and (later) Postgres-backed drivers satisfy (#7175). */
export interface SqliteDriver {
    query(sql: string, params: unknown[]): {
        rows: Record<string, unknown>[];
        changes: number;
        lastInsertRowid: number;
    };
    exec(sql: string): void;
}
/** Minimal D1-shaped surface returned by `createD1Adapter` (async wrappers over SqliteDriver). */
export interface MinerD1Database {
    prepare(sql: string): MinerD1PreparedStatement;
    batch(statements: MinerD1PreparedStatement[]): Promise<unknown[]>;
    exec(sql: string): Promise<{
        count: number;
        duration: number;
    }>;
    dump(): Promise<ArrayBuffer>;
}
export interface MinerD1PreparedStatement {
    bind(...values: unknown[]): MinerD1PreparedStatement;
    all<T = unknown>(): Promise<{
        results: T[];
        success: true;
        meta: Record<string, unknown>;
    }>;
    run<T = unknown>(): Promise<{
        results: T[];
        success: true;
        meta: Record<string, unknown>;
    }>;
    first<T = unknown>(colName?: string): Promise<T | null>;
    raw<T = unknown>(): Promise<T[]>;
}
/**
 * Wrap a synchronous SqliteDriver as a D1-shaped database (async prepare/batch/exec).
 */
export declare function createD1Adapter(driver: SqliteDriver): MinerD1Database;
/**
 * Build a SqliteDriver from a node:sqlite DatabaseSync.
 * A statement with zero result columns is a WRITE; otherwise a READ.
 *
 * LIMITATION (#7175 follow-up): `INSERT/UPDATE/DELETE … RETURNING` statements report result columns, so
 * this heuristic would treat them as reads and drop `changes`/`lastInsertRowid`. claim-ledger and other
 * RETURNING callers must not migrate onto `driver.query` until the heuristic is sharpened (e.g. statement
 * class detection) or those stores use `createD1Adapter`/`run` exclusively.
 */
export declare function nodeSqliteDriver(db: DatabaseSync): SqliteDriver;
