# For Maintainers

Gittensory is designed to make Gittensor-driven contribution flow less noisy. It inspects PRs quietly first and only publishes public output when the author is an officially confirmed Gittensor miner.

## Default Public Behavior

- non-miner authors: no comment, no label, no check
- bot authors: no public output
- maintainer-associated authors: no public output unless explicitly enabled
- confirmed miners: one sticky public-safe comment plus the configured label

::: tip Public GitHub output is sanitized
Comments and labels never include private reviewability scores, wallet data, hotkeys, raw trust scores, public score estimates, or public reward estimates.
:::

## What Maintainers Get

Private API/MCP surfaces can explain:

- contributor role context
- repo-specific outcome history
- linked issue and lane fit
- duplicate or WIP collision risk
- validation evidence
- likely review action: review now, needs author, watch, redirect, or maintainer lane

The GitHub App stays low-noise. It does not close, merge, rewrite, or publicly judge contributor work.

## Explicit Commands

Installed repos can use public-safe mention commands when a maintainer or authorized PR author wants Gittensory context without enabling noisy checks:

- `@gittensory help`
- `@gittensory preflight`
- `@gittensory blockers`
- `@gittensory duplicate-check`
- `@gittensory miner-context`
- `@gittensory next-action`

Maintainers can invoke commands on installed repos. PR authors can invoke commands on their own PRs only when official Gittensor miner detection succeeds. If miner detection is unavailable, Gittensory fails closed and avoids public output.

## Intake Health

Repo owners can use Gittensory signals to inspect:

- queue pressure
- label readiness
- config quality
- maintainer-cut readiness
- whether issue discovery is appropriate yet
- whether the installed GitHub App has the permissions needed for comments and labels

## When To Use Gittensory

- when confirmed Gittensor miner PRs need triage context
- when duplicate or broad PRs are increasing review load
- when you want labels/comments without public check-run noise
- before changing repo rules that affect contributor intake
