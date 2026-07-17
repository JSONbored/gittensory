# Single-machine concurrency inventory — AMS core modules

Citation-backed inventory of every place four named AMS modules currently assume
**single-machine / single-process** execution (in-process mutable state, local file paths,
unguarded shared mutable state, or SQLite file locks that only coordinate on one host). This is
the baseline deliverable for **#5228**; it seeds a separate concurrency-model re-evaluation
already tracked in the AMS Cloud Readiness milestone. **Documentation only** — no redesign, no
code changes, no prescriptions about what “should” replace these assumptions.

> Post-rebrand paths: `packages/loopover-engine` and `packages/loopover-miner` are what #5228
> refers to as `packages/gittensory-engine` and `packages/gittensory-miner`.

## Assumption categories (descriptive labels only)

| Label | Meaning in this inventory |
| --- | --- |
| **in-process mutable state** | Loop- or call-local variables that encode progress; correct only for one concurrent driver of that call. |
| **process-wide singleton** | Module-scoped lazy default reused for the whole Node process. |
| **local file path** | Persistence or working tree rooted on this machine’s filesystem (`cwd`, config-dir SQLite, etc.). |
| **SQLite file lock** | Coordination via `BEGIN IMMEDIATE` / atomic `UPDATE` on a local DB file — not a distributed lock. |
| **none (pure)** | No shared mutable state and no machine-local persistence in this module itself. |

## Summary

| Module | Primary assumption today |
| --- | --- |
| `loopover-engine` `iterate-loop.ts` | One sequential in-process loop over a caller-supplied `workingDirectory`; progress is call-local mutable state; abort is cooperative between iterations only. |
| `loopover-engine` `submission-gate.ts` | Pure decision function; no local concurrency surface (kill-switch is read via a shared helper, not stored here). |
| `loopover-engine` `lint-guard.ts` | Checks run against a single local `cwd` (default `process.cwd()`); package checks are sequential in one call; no lock against a second concurrent guard on the same tree. |
| `loopover-miner` `portfolio-queue.js` | One machine-local SQLite file + process-wide default-store singleton; claim/batch-claim coordination is SQLite file locking on that host. |

Related (already documented elsewhere, not re-audited here): process-wide default-store singletons across miner `lib/*` — [`global-singleton-tenant-audit.md`](global-singleton-tenant-audit.md) (#5218); operator notes on SQLite `busy_timeout` and multi-process collisions — [`operations-runbook.md`](operations-runbook.md).

## Findings by module

### `packages/loopover-engine/src/miner/iterate-loop.ts`

Local create→score→self-review→decide orchestrator (`runIterateLoop` / `runIterateLoopCore`).

| Location | What exists today | Category |
| --- | --- | --- |
| `IterateLoopInput.workingDirectory` (type ~L46; passed into the driver task at ~L417) | Every iteration runs the coding-agent driver against one caller-supplied working directory. The loop does not allocate, lock, or fence that path; exclusivity is assumed by the caller. | **local file path** (caller-owned worktree) |
| `runIterateLoopCore` locals `previousBlockerCodes`, `totalTurnsUsed`, `totalCostUsd`, `iterations` (~L375–L378) | Progress and no-progress comparison state live in closed-over `let` bindings for one loop invocation. A second concurrent `runIterateLoop` call on the same attempt would not share these vars, but nothing in this module serializes two loops that target the same `workingDirectory` or `attemptId`. | **in-process mutable state** |
| `MeterTracker` totals / breaches updated each iteration (~L428–L435) | Cumulative budget metering is mutated on the tracker object for this call only. | **in-process mutable state** |
| Sequential `for` over `maxIterations` (~L380) | Iterations are strictly serial in one async function (await driver → self-review → policy). There is no worker-pool or cross-iteration parallelism inside the loop. | **in-process mutable state** (single-threaded control flow) |
| Cooperative `shouldAbort` probe (~L381–L412) | Kill/pause is checked **before** each driver invocation. An in-flight driver turn is not interrupted (comment at ~L383–L384). Coordination is in-process and cooperative, not OS-level. | **in-process mutable state** |
| Module scope | No module-level `let` singleton or shared Map; all concurrency-relevant state is per-call. | (no process-wide singleton in this file) |

### `packages/loopover-engine/src/miner/submission-gate.ts`

Gated-submission chokepoint (`shouldSubmit`).

| Location | What exists today | Category |
| --- | --- | --- |
| `shouldSubmit` (~L110–L125) | Pure function over the candidate object: identical inputs → identical decision. No caches, counters, or file IO in this module. | **none (pure)** |
| `SLOP_BAND_SEVERITY` (~L44–L49) | Frozen module-level severity table; immutable, not a concurrency control. | **none (pure)** |
| Kill-switch check via `isMinerKillSwitchActive(candidate.killSwitchScope)` (~L111–L112) | Reads the shared kill-switch helper (env / scope resolved by the caller). This file does not own mutable kill-switch state; any process-wide nature of the switch lives in `kill-switch.ts`, not here. | **none (pure)** in this file (delegates outward) |

### `packages/loopover-engine/src/miner/lint-guard.ts`

Post-edit check wrapper (`guardChangedFiles` / `guardCodingAgentDriverResult`).

| Location | What exists today | Category |
| --- | --- | --- |
| `LintGuardOptions.cwd` default `process.cwd()` (~L59–L60, applied ~L98) | Checks spawn against one local repo root. Concurrent guards in different processes on the same checkout are not coordinated by this module. | **local file path** |
| Ephemeral `byPackage` `Map` (~L99–L105) | Groups changed files for one `guardChangedFiles` call; discarded when the call returns. | **in-process mutable state** (call-local only) |
| Sequential `for … of byPackage` with `await runPackageCheck` (~L108–L110) | Package checks run one after another inside a single guard invocation (no bounded fan-out). | **in-process mutable state** (serial IO) |
| `runPackageCheck` spawns `node --check` / `npm run typecheck` / workspace build / `ui:typecheck` (~L69–L86) | Real subprocesses against the local tree. Assumes that tree is the machine’s working copy for this `cwd`; does not take a filesystem lock before spawning. | **local file path** |

### `packages/loopover-miner/lib/portfolio-queue.js`

Client-side prioritized backlog store (`initPortfolioQueueStore`, default accessors).

| Location | What exists today | Category |
| --- | --- | --- |
| Header / store role (~L6–L10) | Explicitly a **machine-local** SQLite backlog; “never uploads, syncs, or phones home.” | **local file path** |
| `defaultDbFileName` + `let defaultPortfolioQueueStore = null` (~L14–L15) | Process-wide lazy default store. | **process-wide singleton** |
| `resolvePortfolioQueueDbPath` (~L17–L18) | Resolves via `resolveLocalStoreDbPath` / `LOOPOVER_MINER_PORTFOLIO_QUEUE_DB` to a config-dir file (default name `portfolio-queue.sqlite3`). | **local file path** |
| `getDefaultPortfolioQueueStore` (~L399–L401) | `defaultPortfolioQueueStore ??= initPortfolioQueueStore()` — one handle reused for module-level `enqueue` / `dequeueNext` / … exports (~L404+). | **process-wide singleton** |
| Atomic `dequeueStatement` (`UPDATE … WHERE rowid = (SELECT … LIMIT 1)`) (~L201–L212, used ~L287–L288) | Claim is atomic **inside one SQLite database file**. Comment notes a separate SELECT-then-UPDATE would race; coordination is DB-engine locking on that file, not a distributed claim service. | **SQLite file lock** |
| Global dequeue (no `api_base_url` filter) (~L203–L204) | One process’s default queue is a single ordered backlog across forge hosts for that DB file. | **local file path** + single-file queue semantics |
| `batchClaim` `BEGIN IMMEDIATE` … `COMMIT` / `ROLLBACK` (~L344–L365) | Caps-aware batch claim takes an exclusive SQLite write lock for the transaction, re-reads active rows, then flips still-queued targets. Exclusive lock scope is the local DB file. | **SQLite file lock** |
| Stale-lease / reclaim fields (`leased_at`, reclaim/release statements) (~L100+, ~L225–L231) | Crash recovery assumes leases timed out on **this** machine’s DB; there is no cross-host lease authority in this module. | **local file path** |

## Out of scope for this inventory

- Redesign proposals, hosted multi-writer models, or tenant partitioning (those belong to the separate milestone design issue).
- Modules beyond the four named in #5228 (broader singleton list: [`global-singleton-tenant-audit.md`](global-singleton-tenant-audit.md)).
- Changing behavior of any cited code.
