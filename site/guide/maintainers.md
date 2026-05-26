# For Maintainers

Gittensory is meant to make Gittensor-driven contribution flow less noisy.

## GitHub App Surface

The GitHub App is designed to stay quiet unless a PR author is an officially confirmed Gittensor miner.

Default visible output for confirmed miner PRs:

- one sticky public-safe PR comment
- one maintainer-configured label, defaulting to `gittensor`
- no public output for bots, non-miners, or maintainer-associated authors unless explicitly enabled

Private reviewability context, queue risk, score blockers, and reward/risk reasoning stay in the API/MCP. GitHub checks default to off; if a maintainer enables them later, they remain minimal and do not carry detailed findings.

## Reviewability Actions

Gittensory maps PRs to maintainer-friendly actions:

- `review_now`
- `needs_author`
- `likely_duplicate`
- `close_or_redirect`
- `watch`
- `maintainer_lane`

The point is not to shame contributors. The point is to identify the lowest-friction next step.

## Public Comments

Confirmed miner comments can include:

- contribution context
- PR hygiene
- duplicate or WIP risk
- maintainer review notes
- contributor next steps

Comments must not include raw trust scores, wallet data, hotkeys, public reward estimates, or public score optimization language.

## Repo Owner Signals

Repo owners can use Gittensory to inspect:

- repo lane clarity
- label configuration
- maintainer cut readiness
- queue health
- contributor intake health
- GitHub App installation health
- stale or degraded backfill state
