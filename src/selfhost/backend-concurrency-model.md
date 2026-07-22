# Shared backend concurrency model — verification & design doc (#4942)

The AMS local-store concurrency guarantees were originally designed for **two local processes sharing one
SQLite file**. #7175 migrated that layer off `node:sqlite`-directly and onto the shared
`SelfHostD1Database` seam (`src/selfhost/backend-contracts.ts`, #4010), which has two interchangeable
adapters — a SQLite one and a Postgres one. This doc records what concurrency the two adapters actually
guarantee (and what they don't), so the hosted service's assumptions are stated explicitly instead of
being inherited implicitly from the old local-file design. The claims below are pinned by
`test/unit/selfhost-d1-concurrency.test.ts` (SQLite) and the `PG_TEST_URL`-gated
`test/integration/selfhost-pg.test.ts` (Postgres).

## The seam

Both adapters implement one contract, `SelfHostD1Database` (`backend-contracts.ts:87-94`):
`prepare` / `batch` / `exec` / `dump`, where `batch(statements)` (`backend-contracts.ts:89`) is documented
as running "a batch atomically, one result per statement, in order" (`d1-adapter.ts:76`). Every ~171
data-access call site in loopover goes through this one surface, so its atomicity is the guarantee the
whole application leans on.

- **SQLite adapter** — `createD1Adapter(driver)` (`src/selfhost/d1-adapter.ts:70`) over the synchronous
  `SqliteDriver` primitive (`d1-adapter.ts:20-23`); the default driver is `nodeSqliteDriver` over
  `node:sqlite` (`d1-adapter.ts:116`). The D1 API is async, but the driver is **synchronous** — the async
  methods only wrap resolved values, so there is no real preemption inside a single statement.
- **Postgres adapter** — `createPgAdapter(pool)` (`src/selfhost/pg-adapter.ts:62`) over a `node-postgres`
  `Pool`; a real pooled, async, multi-connection client.

## SQLite backend

**Topology.** One process, one connection, one file. This is not incidental — it is the supported topology
for the whole admission system: "single-process-per-deployment is already the supported topology […] the
SQLite backend structurally cannot share state across processes at all"
(`installation-concurrency-admission.ts:10-16`). "Concurrency" against this backend therefore means
**event-loop interleaving of the async D1 surface within one process**, not OS-level multi-connection
contention.

**Atomicity.** `batch()` wraps its statements in `BEGIN` / `COMMIT`, with `ROLLBACK` on any error
(`d1-adapter.ts:75-90`). Because the driver is synchronous, a `batch()` runs start-to-finish with no
`await` between `BEGIN` and `COMMIT`, so no other operation can observe a partially-applied batch.

**What is guaranteed**

- A single self-contained write statement (e.g. `UPDATE … SET value = value + 1`) is applied in full; N
  such concurrent statements lose no updates (final value == N). _(test: "N concurrent atomic increments")_
- `batch()` is all-or-nothing: a failing statement rolls back the entire batch, leaving no partial write.
  _(test: "a failing statement rolls back the whole batch")_
- A committed batch applies every statement, in order. _(test: "applies every statement, in order")_
- A read interleaved with a batch sees only the pre- or post-batch state, never an uncommitted
  intermediate. _(test: "never observes a rolled-back intermediate state")_

**What is NOT guaranteed**

- **Non-atomic read-modify-write is not safe**, exactly as on any backend. Splitting an increment into an
  awaited read then an awaited write lets concurrent sequences all read the same value before any write
  lands, losing all but one update _(test: "concurrent non-atomic read-modify-write … DO lose updates")_.
  Callers must use a single atomic statement, a `batch()`, or a `UNIQUE`-constrained upsert — not a
  read-then-write pair.
- **Cross-process sharing is out of scope** for this backend. `nodeSqliteDriver` sets no PRAGMAs itself;
  the production open path (`src/server.ts:266`) applies `PRAGMA journal_mode = WAL; PRAGMA busy_timeout =
5000;`, which lets a single deployment's short serialized write windows resolve without `SQLITE_BUSY`
  (`src/selfhost/sqlite-queue.ts:142`), but multi-writer cross-process durability is a Postgres concern,
  not a SQLite one.

## Postgres backend

`batch()` acquires a dedicated pooled connection, runs `BEGIN`, executes each statement on that client,
then `COMMIT` — or `ROLLBACK` and rethrow on error — before releasing the connection
(`pg-adapter.ts:65-83`). This is real cross-connection transactional isolation: concurrent tenants run on
distinct pooled connections, and each `batch()` is an isolated transaction.

**What is guaranteed**

- Each `batch()` is an isolated transaction; a failure rolls the whole batch back on its connection. _(the
  `PG_TEST_URL`-gated batch-rollback test in `test/integration/selfhost-pg.test.ts`)_
- Distinct connections give genuine parallelism across tenant sessions.

**What is NOT guaranteed**

- Application-level lost-update protection for a read-then-write spanning two separate statements — the
  same rule as SQLite. Use row locking (`SELECT … FOR UPDATE`), a `UNIQUE` constraint, or a single atomic
  statement inside the batch.

## Why the tests are split this way

The SQLite guarantees are verified deterministically **in-process** (the backend's real topology), so they
run in the standard `validate-tests` suite with no external dependency and no flakiness. Real
multi-connection Postgres concurrency needs a live server, so it stays behind the existing
`PG_TEST_URL`-gated integration suite rather than being faked with a scripted mock pool (which cannot
exhibit real race behavior). The shared takeaway for callers is backend-independent: **atomicity is a
property of the statement/`batch()` you write, not something either backend adds to a read-modify-write
pair for free.**
