# @jsonbored/gittensory-miner

Foundation CLI for the local Gittensory miner runtime.

This package is the future home of the autonomous discover → analyze → plan → prepare → create → manage miner workflow. In this foundation phase it only provides the package scaffold and a minimal CLI surface for `--help` and `--version`.

## Status

Current scope is intentionally small:

- workspace package wiring
- CLI entry point
- `--help` and `version` commands

Real miner commands land in follow-up issues.

## Install

From a local checkout:

```sh
npm install
npm --workspace @jsonbored/gittensory-miner run build
```

## Commands

```sh
gittensory-miner --help
gittensory-miner help
gittensory-miner --version
gittensory-miner version
```
