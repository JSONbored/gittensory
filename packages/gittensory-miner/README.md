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

The package also records local PR outcomes: `recordPrOutcomeSnapshot` / `readPrOutcomes` write and reduce the
miner's OWN record of the outcomes of its OWN PRs (merged / closed, with an optional rejection-reason bucket) over
the append-only event ledger above. This is DISTINCT from the gittensory server's `recordPrOutcome`
(`src/review/outcomes-wire.ts`), which writes hosted-backend audit rows from the GitHub App's webhook stream — same
concept name, different codebase layer, no shared code (a laptop-mode miner may have no webhook relay at all). (#4274)

The package also includes an append-only prediction ledger: `initPredictionLedger` / `appendPrediction` /
`readPredictions` persist each predicted-gate verdict (conclusion / pack / readiness score + blocker/warning
codes, plus the producing `ENGINE_VERSION`) in local SQLite, so a later self-improve pass can score predictions
against realized outcomes. Insert-only. (#4263)

`gittensory-miner manage status` now also folds each tracked repo's current discover/plan/prepare run state
(`run-state.js`) alongside its managed PR rows into a "run portfolio" view — `collectRunPortfolio` /
`renderRunPortfolioTable` — so a repo actively being discovered or planned shows up even with zero PRs yet.
Additive only: the existing `rows` JSON key and PR table are unchanged; `runPortfolio` is a new key printed
after the existing table. A real GUI dashboard surface is out of scope here — `apps/gittensory-miner-ui/` is
Phase 6 of the same roadmap tracker and hasn't been scaffolded yet. (#4279)

## Install

See [`docs/miner-goal-spec.md`](docs/miner-goal-spec.md) for the `.gittensory-miner.yml` field reference and [`.gittensory-miner.yml.example`](../../.gittensory-miner.yml.example) at the repo root.

See [`docs/cross-repo-discovery-phase1.md`](docs/cross-repo-discovery-phase1.md) for the Phase 1 cross-repo discovery scope (re-scoped from [#1060](https://github.com/JSONbored/gittensory/issues/1060), paper trail for [#2299](https://github.com/JSONbored/gittensory/issues/2299)).

See [`docs/discovery-plane-operator-guide.md`](docs/discovery-plane-operator-guide.md) for the optional hosted discovery-index plane (opt-in default OFF; contrasts with Orb's opt-out-only export — [#4309](https://github.com/JSONbored/gittensory/issues/4309)).

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

## Commands

```sh
gittensory-miner --help
gittensory-miner help
gittensory-miner --version
gittensory-miner version
gittensory-miner init [--json]
gittensory-miner status [--json]
gittensory-miner doctor [--json]
gittensory-miner manage status [--json]
gittensory-miner manage poll <owner/repo> <pr#> [--branch <name>] [--json]
```

## Version check

On every invocation the CLI starts an async npm registry lookup (5s timeout). When the installed package is behind `@jsonbored/gittensory-miner@latest`, it prints a one-line upgrade command to stderr without blocking or failing the requested command. Set `GITTENSORY_NPM_REGISTRY_URL` to point at a mirror, same as `@jsonbored/gittensory-mcp`.
