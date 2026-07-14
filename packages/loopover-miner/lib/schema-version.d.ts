import type { DatabaseSync } from "node:sqlite";

/** A single post-baseline schema migration: mutate the store in place to advance it exactly one version. */
export type SchemaMigration = (db: DatabaseSync) => void;

/** The bootstrap schema every store creates inline is, by convention, schema version 1. */
export const BASELINE_SCHEMA_VERSION: number;

/** Read a store's current `PRAGMA user_version`, coercing any absent/invalid value to 0 (pre-versioning). */
export function readSchemaVersion(db: DatabaseSync): number;

/**
 * Run pending post-baseline migrations in order and stamp the resulting `user_version`. `migrations[i]` upgrades
 * from version i+1 to i+2, so the target version is `BASELINE_SCHEMA_VERSION + migrations.length`. Returns the
 * resulting version.
 */
export function applySchemaMigrations(db: DatabaseSync, migrations?: SchemaMigration[]): number;
