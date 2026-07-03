import type { DatabaseSync } from "node:sqlite";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

export const RAW_SQL_ONLY_TABLES: Set<string>;

export function replayMigrations(dir: string): DatabaseSync;

export function listActualTables(db: DatabaseSync): Set<string>;

export function actualColumnsFor(db: DatabaseSync, table: string): Set<string>;

export function collectSchemaTables(schemaModule: Record<string, unknown>): Map<string, SQLiteTable>;

export function declaredColumnsFor(table: SQLiteTable): Set<string>;

export function diffSchemaAgainstMigrations(db: DatabaseSync, schemaModule: Record<string, unknown>, rawSqlOnlyTables?: Set<string>): string[];
