# @jsonbored/gittensory-miner

Foundation CLI for the local Gittensory miner runtime.

This package is the future home of the autonomous discover → analyze → plan → prepare → create → manage miner workflow. In this foundation phase it provides the package scaffold, a minimal CLI surface for `--help` and `--version`, and a non-blocking npm registry version nudge on startup.

## Status

Current scope is intentionally small:

- workspace package wiring
- CLI entry point
- `--help` and `version` commands
- startup npm version nudge (override with `--no-update-check` or `GITTENSORY_MINER_NO_UPDATE_CHECK=1`)

Real miner commands land in follow-up issues.

The package also includes the first metadata-only discovery primitive: `fetchCandidateIssues` lists open issue
metadata across target repos, and `searchCandidateIssues` does the same from a GitHub issue-search query. Both
paths hard-skip repos whose `AI-USAGE.md` or `CONTRIBUTING.md` explicitly bans AI-generated PRs. They perform
GitHub GET requests only, never clone source, never upload source, and never write to GitHub.

The package also includes a metadata-only ranker: `rankCandidateIssues` composes deterministic engine signals
(potential, feasibility, lane fit, freshness, dup risk) and returns fan-out candidates sorted by `rankScore`.
It never clones source and never writes to GitHub.

The package also includes an append-only governor decision ledger: `initGovernorLedger` / `appendGovernorEvent`
persist structured allow/deny/throttle/kill-switch outcomes in local SQLite for contributor audit. Insert-only —
no enforcement wiring yet. (#2328)

The package also includes a local soft-claim ledger: `openClaimLedger` / `claimIssue` / `releaseClaim` /
`listActiveClaims` persist which issues this miner instance has claimed on this machine. The table is local
bookkeeping only — duplicate winners are adjudicated elsewhere via `@jsonbored/gittensory-engine`. (#2291)

The package also includes an append-only event ledger: `initEventLedger` / `appendEvent` / `readEvents` persist
immutable miner-loop events in local SQLite for contributor audit. Insert-only — rows are never updated or
deleted. (#2322)

## Install

See [`docs/miner-goal-spec.md`](docs/miner-goal-spec.md) for the `.gittensory-miner.yml` field reference and [`.gittensory-miner.yml.example`](../../.gittensory-miner.yml.example) at the repo root.

See [`docs/cross-repo-discovery-phase1.md`](docs/cross-repo-discovery-phase1.md) for the Phase 1 cross-repo discovery scope (re-scoped from [#1060](https://github.com/JSONbored/gittensory/issues/1060), paper trail for [#2299](https://github.com/JSONbored/gittensory/issues/2299)).

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for laptop vs fleet deployment.

### Laptop-mode quickstart

Zero-infra local install — no Docker, Redis, or Postgres required:

```sh
npm install -g @jsonbored/gittensory-miner
gittensory-miner init
gittensory-miner doctor
gittensory-miner status
```

`init` creates `~/.config/gittensory-miner/` (or `GITTENSORY_MINER_CONFIG_DIR` / `XDG_CONFIG_HOME` overrides) and a local `laptop-state.sqlite3` bootstrap file. Re-running `init` is idempotent. `doctor` reports Node, the state directory, SQLite readiness, and whether Docker is installed (informational only).

From a local checkout:

```sh
npm install
npm --workspace @jsonbored/gittensory-miner run build
npm link --workspace @jsonbored/gittensory-miner
```

## Local storage

Every local, 100%-client-side SQLite store the miner writes lives under the same config directory
(`GITTENSORY_MINER_CONFIG_DIR`, else `XDG_CONFIG_HOME`/`~/.config/gittensory-miner`) and never uploads,
syncs, or phones home. Each store keeps its own file — this is a set of independent SQLite databases, not
one shared database — but six of them resolve their path and open their file through the same shared
helper (`lib/local-store.js`), so the override precedence (explicit path env var → config dir → XDG
default) and file permissions (`0o700` dir, `0o600` file) are identical everywhere:

| File | Table | Module | Path override env var |
| --- | --- | --- | --- |
| `run-state.sqlite3` | `miner_run_state` | `lib/run-state.js` | `GITTENSORY_MINER_RUN_STATE_DB` |
| `claim-ledger.sqlite3` | `miner_claims` | `lib/claim-ledger.js` | `GITTENSORY_MINER_CLAIM_LEDGER_DB` |
| `portfolio-queue.sqlite3` | `miner_portfolio_queue` | `lib/portfolio-queue.js` | `GITTENSORY_MINER_PORTFOLIO_QUEUE_DB` |
| `event-ledger.sqlite3` | `miner_event_ledger` | `lib/event-ledger.js` | `GITTENSORY_MINER_EVENT_LEDGER_DB` |
| `governor-ledger.sqlite3` | `governor_events` | `lib/governor-ledger.js` | `GITTENSORY_MINER_GOVERNOR_LEDGER_DB` |
| `plan-store.sqlite3` | `miner_plans` | `lib/plan-store.js` | `GITTENSORY_MINER_PLAN_STORE_DB` |
| `laptop-state.sqlite3` | `laptop_meta` | `lib/laptop-init.js` | none — created by `init`, not per-file overridable |

`laptop-state.sqlite3` predates the shared helper and keeps its own inline path resolution in
`laptop-init.js` deliberately (a `status.js` → `laptop-init.js` import already exists, so importing
`local-store.js`'s resolver from `status.js` back into `laptop-init.js` would cycle).

There is no dedicated "PR portfolio" table. `manage-status.js`'s `indexLatestManageUpdates` synthesizes
PR-portfolio rows at read time by joining `portfolio-queue.js` rows (via the `pr:{number}` identifier
convention) against `event-ledger.js`'s `manage_pr_update` events. That read-time join is the intended
shape for this foundation phase — it stays until PR-portfolio reads get frequent enough (e.g. from a
dashboard panel) to justify promoting it to a first-class indexed table.

## Commands

```sh
gittensory-miner --help
gittensory-miner help
gittensory-miner --version
gittensory-miner version
gittensory-miner init [--json]
gittensory-miner status [--json]
gittensory-miner doctor [--json]
```

## Version check

On every invocation the CLI starts an async npm registry lookup (5s timeout). When the installed package is behind `@jsonbored/gittensory-miner@latest`, it prints a one-line upgrade command to stderr without blocking or failing the requested command. Set `GITTENSORY_NPM_REGISTRY_URL` to point at a mirror, same as `@jsonbored/gittensory-mcp`.
