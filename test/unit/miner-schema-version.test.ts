import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  applySchemaMigrations,
  readSchemaVersion,
  BASELINE_SCHEMA_VERSION,
} from "../../packages/gittensory-miner/lib/schema-version.js";

type Migration = (db: DatabaseSync) => void;

/** A minimal store whose bootstrap table already exists (the `CREATE TABLE IF NOT EXISTS` convention). */
function freshStore(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)");
  return db;
}

describe("schema-version migration runner (#4832)", () => {
  it("treats a pre-versioning file as version 0 and stamps the baseline when there are no migrations", () => {
    const db = freshStore();
    expect(readSchemaVersion(db)).toBe(0);
    expect(applySchemaMigrations(db, [])).toBe(BASELINE_SCHEMA_VERSION);
    expect(readSchemaVersion(db)).toBe(1);
    db.close();
  });

  it("runs every pending migration in order on a pre-versioning file and stamps the target version", () => {
    const db = freshStore();
    const calls: number[] = [];
    const migrations: Migration[] = [
      (d) => {
        d.exec("ALTER TABLE t ADD COLUMN a TEXT");
        calls.push(1);
      },
      (d) => {
        d.exec("ALTER TABLE t ADD COLUMN b TEXT");
        calls.push(2);
      },
    ];
    expect(applySchemaMigrations(db, migrations)).toBe(3); // baseline 1 + 2 migrations
    expect(calls).toEqual([1, 2]);
    expect(readSchemaVersion(db)).toBe(3);
    db.exec("INSERT INTO t (id, a, b) VALUES (1, 'x', 'y')"); // both added columns exist
    db.close();
  });

  it("is idempotent: re-applying the same migrations on an up-to-date file runs none and does not re-stamp", () => {
    const db = freshStore();
    let runs = 0;
    const migrations: Migration[] = [
      (d) => {
        d.exec("ALTER TABLE t ADD COLUMN a TEXT");
        runs += 1;
      },
    ];
    applySchemaMigrations(db, migrations);
    expect(runs).toBe(1);
    expect(applySchemaMigrations(db, migrations)).toBe(2);
    expect(runs).toBe(1); // the already-applied migration did not run again
    db.close();
  });

  it("runs only the outstanding migrations when a file is partway through the history", () => {
    const db = freshStore();
    // A prior release shipped one migration → file is at version 2.
    applySchemaMigrations(db, [(d) => d.exec("ALTER TABLE t ADD COLUMN a TEXT")]);
    expect(readSchemaVersion(db)).toBe(2);
    const ran: string[] = [];
    const migrations: Migration[] = [
      () => ran.push("0"), // already applied — must NOT run
      (d) => {
        d.exec("ALTER TABLE t ADD COLUMN b TEXT");
        ran.push("1");
      },
    ];
    expect(applySchemaMigrations(db, migrations)).toBe(3);
    expect(ran).toEqual(["1"]);
    db.close();
  });

  it("never downgrades a file written by newer code (current > target): no migrations run, version unchanged", () => {
    const db = freshStore();
    // Newer code (2 migrations) stamped this file at version 3.
    applySchemaMigrations(db, [
      (d) => d.exec("ALTER TABLE t ADD COLUMN a TEXT"),
      (d) => d.exec("ALTER TABLE t ADD COLUMN b TEXT"),
    ]);
    expect(readSchemaVersion(db)).toBe(3);
    // Older code that only knows one migration opens the same file: it must run nothing and must NOT stamp the
    // version back down to its own target of 2.
    let ran = 0;
    const resulting = applySchemaMigrations(db, [
      () => {
        ran += 1;
      },
    ]);
    expect(ran).toBe(0);
    expect(readSchemaVersion(db)).toBe(3); // left at the newer version, not downgraded to 2
    expect(resulting).toBe(3); // reports the file's actual (higher) version
    db.close();
  });

  it("coerces an absent, non-integer, or negative user_version to 0", () => {
    const absent = { prepare: () => ({ get: () => undefined }) } as unknown as DatabaseSync;
    expect(readSchemaVersion(absent)).toBe(0);
    const nonInteger = { prepare: () => ({ get: () => ({ user_version: "oops" }) }) } as unknown as DatabaseSync;
    expect(readSchemaVersion(nonInteger)).toBe(0);
    const negative = { prepare: () => ({ get: () => ({ user_version: -3 }) }) } as unknown as DatabaseSync;
    expect(readSchemaVersion(negative)).toBe(0);
  });
});
