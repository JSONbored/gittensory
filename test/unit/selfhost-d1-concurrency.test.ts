import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createD1Adapter,
  nodeSqliteDriver,
} from "../../src/selfhost/d1-adapter";

// Concurrency-model verification for the shared SQLite backend (#4942). The AMS local-store guarantees were
// designed for two local processes sharing one file; #7175 migrated that layer onto the shared
// pg-adapter/SqliteDriver seam, so the guarantees the hosted service now actually relies on need to be
// verified against the real seam and documented, not assumed to still hold implicitly. This file pins down
// the SQLite side's guarantees under concurrent access from the async D1 surface (the model the SQLite
// backend actually has: a single process, a synchronous driver, operations serialized on the event loop --
// see src/selfhost/backend-concurrency-model.md). The Postgres side's real cross-connection concurrency is
// exercised by the PG_TEST_URL-gated test/integration/selfhost-pg.test.ts, since it needs a live server.

function makeDb(): D1Database {
  // The production open path (src/server.ts) sets these exact PRAGMAs; use them here so the seam under test
  // matches the deployed configuration. An in-memory db is a single connection, which is the SQLite backend's
  // real topology (single process, one file/connection) -- concurrency here is event-loop interleaving of the
  // async D1 surface, not OS-level multi-connection contention.
  const db = new DatabaseSync(":memory:");
  db.exec(
    "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
  );
  return createD1Adapter(nodeSqliteDriver(db as never));
}

async function readCounter(d1: D1Database): Promise<number> {
  return (
    (await d1
      .prepare("SELECT value FROM counters WHERE id = 'c'")
      .first<number>("value")) ?? -1
  );
}

let d1: D1Database;

beforeEach(async () => {
  d1 = makeDb();
  await d1.exec(
    "CREATE TABLE counters (id TEXT PRIMARY KEY, value INTEGER NOT NULL);",
  );
  await d1.prepare("INSERT INTO counters (id, value) VALUES ('c', 0)").run();
});

describe("shared SQLite backend concurrency guarantees (#4942)", () => {
  it("GUARANTEE: N concurrent atomic increments lose no updates (final value == N)", async () => {
    const N = 50;
    // A single self-contained UPDATE acquires the write path atomically; the synchronous driver runs each to
    // completion before the next resumes, so every increment is applied.
    await Promise.all(
      Array.from({ length: N }, () =>
        d1
          .prepare("UPDATE counters SET value = value + 1 WHERE id = 'c'")
          .run(),
      ),
    );
    expect(await readCounter(d1)).toBe(N);
  });

  it("BOUNDARY: N concurrent non-atomic read-modify-write across awaits DO lose updates", async () => {
    const N = 50;
    // The documented hazard: splitting the increment into an awaited read then an awaited write lets every
    // sequence read the same pre-write value before any write lands, so all but one update is lost. This is
    // deterministic here (the read executes synchronously when first() is called, so all N observe 0), and is
    // the exact reason callers must use a single atomic statement or a batch()/transaction -- not because the
    // backend is "broken", but because read-modify-write is not atomic on any backend without one.
    await Promise.all(
      Array.from({ length: N }, async () => {
        const current = await readCounter(d1);
        await d1
          .prepare("UPDATE counters SET value = ? WHERE id = 'c'")
          .bind(current + 1)
          .run();
      }),
    );
    const final = await readCounter(d1);
    expect(final).toBeLessThan(N);
    expect(final).toBe(1);
  });

  it("GUARANTEE: batch() is atomic -- a failing statement rolls back the whole batch (no partial write)", async () => {
    // Second statement violates the PRIMARY KEY, so the batch must ROLLBACK and leave the counter untouched.
    await expect(
      d1.batch([
        d1.prepare("UPDATE counters SET value = 99 WHERE id = 'c'"),
        d1.prepare("INSERT INTO counters (id, value) VALUES ('c', 1)"), // duplicate PK -> throws
      ]),
    ).rejects.toThrow();
    expect(await readCounter(d1)).toBe(0);
  });

  it("GUARANTEE: a committed batch applies every statement, in order", async () => {
    await d1.batch([
      d1.prepare("UPDATE counters SET value = value + 10 WHERE id = 'c'"),
      d1.prepare("UPDATE counters SET value = value * 2 WHERE id = 'c'"),
    ]);
    expect(await readCounter(d1)).toBe(20); // (0 + 10) * 2
  });

  it("GUARANTEE: a read concurrent with an atomic batch never observes a rolled-back intermediate state", async () => {
    // The batch runs BEGIN..COMMIT/ROLLBACK synchronously with no await inside, so an interleaved read can
    // only see the pre-batch or post-batch value, never a partially-applied one.
    const failing = d1
      .batch([
        d1.prepare("UPDATE counters SET value = 77 WHERE id = 'c'"),
        d1.prepare("INSERT INTO counters (id, value) VALUES ('c', 2)"), // duplicate PK -> rollback
      ])
      .catch(() => "rolled-back");
    const observed = await readCounter(d1);
    await failing;
    expect(observed).toBe(0); // never the uncommitted 77
    expect(await readCounter(d1)).toBe(0);
  });
});
