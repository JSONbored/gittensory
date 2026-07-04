# @jsonbored/gittensory-miner

Foundation CLI for the local Gittensory miner runtime.

This package is the future home of the autonomous discover → analyze → plan → prepare → create → manage miner
workflow. It is currently in its **foundation phase**: the local state stores, the read-only `status`/`doctor`
commands, the deny-hook safety primitive, and the metadata-only discovery/ranking primitives exist, but there is
no live coding-agent loop yet — nothing scans source, invokes a coding agent, or writes to GitHub.

## 100% local

Everything this package does is client-side and offline by default:

- The run-state, portfolio/queue, claim ledger, event ledger, plan store, and governor ledger are **local SQLite
  files** created owner-only (`0o600`) under your config directory — they never upload, sync, or phone home.
- `status` and `doctor` make **no network calls at all**.
- The metadata-only discovery primitives make GitHub **GET** requests only — they never clone source, never upload
  source, and never write to GitHub, and they hard-skip repos whose `AI-USAGE.md`/`CONTRIBUTING.md` ban AI PRs.
- The miner **never holds shared credentials**: any future write action runs through your own harness with your
  own GitHub credentials.

## Status

Implemented so far (foundation phase):

- **Commands:** `status`, `doctor`, `manage status`/`manage poll`, `queue list`/`next`/`done`, `ledger list`,
  `plan list`/`show`, `governor list`, `hooks check`, `state get`/`state set`, plus `--help`/`--version` and a
  non-blocking startup npm version nudge (override with `--no-update-check` or `GITTENSORY_MINER_NO_UPDATE_CHECK=1`).
- **Local state stores (SQLite):** run-state, portfolio/queue, claim ledger, append-only event ledger, plan store,
  and an append-only governor decision ledger — each a separate owner-only file with a resolved config path,
  surfaced read-only through the `queue`/`ledger`/`plan`/`governor`/`manage` commands.
- **Deny-hook primitive:** `evaluateDenyHooks` + a built-in house-rule set, surfaced via `hooks check`.
- **Metadata-only discovery:** `fetchCandidateIssues`/`searchCandidateIssues` list open issue metadata across
  target repos (GitHub GETs only), hard-skipping AI-banning repos.
- **Metadata-only ranker:** `rankCandidateIssues` composes deterministic engine signals (potential, feasibility,
  lane fit, freshness, dup risk) and returns fan-out candidates sorted by `rankScore`.

The live discover → analyze → plan → prepare → create → manage loop lands in follow-up issues.

## Install

Public npm (once published):

```sh
npm install -g @jsonbored/gittensory-miner
```

From a local checkout of this repo:

```sh
npm install
npm link --workspace @jsonbored/gittensory-miner
```

## Commands

```sh
gittensory-miner status [--json]           # installed miner + engine version, Node, local-state dir, config file
gittensory-miner doctor [--json]           # check Node version, engine resolves, state dir writable (non-zero on failure)

gittensory-miner manage status [--json]                              # show managed PR rows from local portfolio + ledger
gittensory-miner manage poll <owner/repo> <pr#> [--branch <name>] [--json]

gittensory-miner queue list [--repo <owner/repo>] [--json]           # list portfolio backlog rows
gittensory-miner queue next [--json]                                 # claim the highest-priority queued item
gittensory-miner queue done <owner/repo> <identifier> [--json]       # mark a backlog item done

gittensory-miner ledger list [--repo <owner/repo>] [--since <seq>] [--type <eventType>] [--json]   # read the event ledger
gittensory-miner plan list [--status pending|running|completed|failed] [--json]                    # list stored plans
gittensory-miner plan show <planId> [--json]                                                       # show one plan
gittensory-miner governor list [--repo <owner/repo>] [--type allowed|denied|throttled|kill_switch] [--json]

gittensory-miner hooks check --tool <name> --input <json> [--json]   # evaluate a tool call against the deny-hook house rules
gittensory-miner state get <owner/repo> [--json]                     # read the local per-repo run-state
gittensory-miner state set <owner/repo> <idle|discovering|planning|preparing> [--json]   # set it

gittensory-miner --help        # or: help
gittensory-miner --version     # or: version
```

No command writes to GitHub or uploads source; the `set`/`done`/`next` variants mutate only local state. `status`
and `doctor` are dispatched before the update check runs, so they stay fully offline.

## Configuration — `.gittensory-miner.yml`

A repo owner drops a `.gittensory-miner.yml` into their repo to tell an autonomous miner what to look for and how to
behave when targeting it — the miner-side analogue of `.gittensory.yml` (the review-side focus manifest). Every
field is optional with a safe default, and the file is parsed tolerantly (an unknown or malformed key falls back to
its default with a warning; a broken file never hard-fails the miner). It is **opt-out**: a public repo with no file
is still minable; set the enable flag to `false` to halt all miner targeting.

Discovery order (first match wins):

```
.gittensory-miner.yml → .github/gittensory-miner.yml → .gittensory-miner.json → .github/gittensory-miner.json
```

See [`.gittensory-miner.yml.example`](../../.gittensory-miner.yml.example) for the full field reference (YAML or
JSON are both accepted).

## Version check

On every invocation the CLI starts an async npm-registry lookup (5s timeout). When the installed package is behind
`@jsonbored/gittensory-miner@latest`, it prints a one-line upgrade command to stderr without blocking or failing
the requested command. Set `GITTENSORY_NPM_REGISTRY_URL` to point at a mirror, same as `@jsonbored/gittensory-mcp`.
The `status` and `doctor` commands skip this check entirely (they are strictly offline).
