# @jsonbored/gittensory-mcp

Local stdio MCP wrapper for the Gittensory base-agent layer.

It inspects local git metadata and calls the Gittensory API for branch preflight, score blockers, reward/risk reasoning, contributor decision packs, deterministic next-action planning, and public-safe PR packets. It does not upload source contents in v1.

## Status

The package is public. Gittensory keeps sensitive score, trust, wallet, and maintainer context out of public PR comments.

## Install

Public npm:

```sh
npm install -g @jsonbored/gittensory-mcp
gittensory-mcp login
```

From a local checkout:

```sh
npm install
npm link --workspace @jsonbored/gittensory-mcp
```

## Commands

```sh
gittensory-mcp login
gittensory-mcp logout
gittensory-mcp whoami
gittensory-mcp status
gittensory-mcp changelog
gittensory-mcp doctor
gittensory-mcp init-client --print codex
gittensory-mcp init-client --print claude
gittensory-mcp init-client --print cursor
gittensory-mcp analyze-branch --login jsonbored --json
gittensory-mcp preflight --login jsonbored --json
gittensory-mcp agent plan --login jsonbored --json
gittensory-mcp agent packet --login jsonbored --json
gittensory-mcp agent status <run-id> --json
gittensory-mcp agent explain <run-id> --json
gittensory-mcp --stdio
```

For near-term what-if scoreability, pass the situational assumptions explicitly:

```sh
gittensory-mcp analyze-branch --login jsonbored \
  --pending-merged-prs 3 \
  --expected-open-prs 0 \
  --projected-credibility 0.8 \
  --scenario-note "approved PRs expected to merge" \
  --json
```

## Auth

`login` uses GitHub Device Flow by default. For non-interactive bootstrap:

```sh
gittensory-mcp login --github-token "$(gh auth token)"
```

The wrapper stores a Gittensory session token, not a GitHub token.

## Base-Agent Mode

The agent commands are copilot-only. They rank, explain, preflight, and draft public-safe packets, but they do not edit code, open PRs, post comments, close, merge, or label from the local wrapper.

```sh
gittensory-mcp agent plan --login jsonbored --repo we-promise/sure --json
gittensory-mcp agent packet --login jsonbored --repo we-promise/sure --base origin/main --json
```

The same capabilities are exposed to MCP clients as:

- `gittensory_agent_plan_next_work`
- `gittensory_agent_start_run`
- `gittensory_agent_get_run`
- `gittensory_agent_explain_next_action`
- `gittensory_agent_prepare_pr_packet`

## Environment

- `GITTENSORY_API_URL`
- `GITTENSORY_CONFIG_PATH` or `GITTENSORY_CONFIG_DIR`
- `GITTENSORY_API_TOKEN`, `GITTENSORY_MCP_TOKEN`, or `GITTENSORY_TOKEN`
- `GITHUB_TOKEN` for non-interactive login bootstrap
- `GITTENSOR_SCORE_PREVIEW_CMD`
- `GITTENSOR_ROOT`
- `GITTENSORY_UPLOAD_SOURCE=false`
- `GITTENSORY_SKIP_NPM_VERSION_CHECK=true`

`GITTENSORY_UPLOAD_SOURCE=true` is not supported and fails closed.

## Release Notes

The package ships with `CHANGELOG.md`. Run:

```sh
gittensory-mcp changelog
```

`gittensory-mcp status` also reports the local package version, latest npm version when reachable, API health, auth state, and source-upload posture.
