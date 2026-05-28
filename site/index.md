---
layout: home

hero:
  name: Gittensory
  text: The base agent layer for Gittensor OSS work.
  tagline: MCP branch analysis, deterministic next-action planning, and GitHub App context for Gittensor miners and maintainers. Not a Gittensor frontend.
  image:
    src: /images/gittensor-home-signal.webp
    alt: Gittensor homepage showing live miner, reward, and repository activity.
  actions:
    - theme: brand
      text: Install MCP
      link: /guide/install
    - theme: alt
      text: Miner Workflow
      link: /guide/miners
    - theme: alt
      text: GitHub App
      link: /guide/github-app-setup

features:
  - title: MCP branch preflight
    details: Local metadata-only checks for lane fit, stale base risk, validation evidence, and score blockers.
  - title: Base-agent planning
    details: Copilot-only runs rank next actions, explain blockers, and prepare public-safe PR packets.
  - title: Quiet maintainer surface
    details: Confirmed-miner comments and labels without public check-run noise or private signal leakage.
---

<!-- markdownlint-disable MD041 MD033 -->

<section class="gtn-install-strip" aria-label="Start with Gittensory MCP">
  <div class="gtn-install-copy">
    <p class="gtn-eyebrow">Start now</p>
    <h2>Let the agent rank the next move before the work becomes review load.</h2>
    <p>One local command gives your agent lane fit, queue pressure, score blockers, next actions, and a public-safe PR packet.</p>
  </div>
  <div class="gtn-install-command" aria-label="Recommended Gittensory command">
    <span>Metadata-only base-agent planning</span>
    <code>gittensory-mcp agent plan --login YOUR_GITHUB_LOGIN --json</code>
  </div>
</section>

Prefer a full setup first? Start with [install](/guide/install), run `gittensory-mcp login`, then add `gittensory-mcp --stdio` to Codex, Claude, or Cursor.

## Pick A Path

- [Install the MCP package](/guide/install): get the CLI, authenticate with GitHub Device Flow, and verify local setup with `doctor`.
- [Connect an MCP client](/guide/mcp): print Codex, Claude Desktop, or Cursor config without mutating local files.
- [Check miner work](/guide/miners): run agent planning, branch analysis, scenario projections, and preflight before opening a PR.
- [Set up the GitHub App](/guide/github-app-setup): give maintainers confirmed-miner comments and labels without noisy checks.
- [Review maintainer behavior](/guide/maintainers): understand quiet-by-default PR visibility and public-safe output boundaries.
- [Read the API contract](/reference/api): inspect the modern private API for decision packs, branch analysis, reviewability, and readiness.

## Where It Fits

| Audience | Gittensory adds |
| --- | --- |
| Gittensor miners | Scoreability blockers, lane fit, queue pressure, local diff quality, and cleanup-first guidance. |
| Maintainers | Confirmed-miner comments, configured labels, and private reviewability packets. |
| Coding agents | Structured MCP tools for repo context, base-agent plans, current branch preflight, next actions, and PR packet drafting. |
| Repo owners | Config quality, label readiness, maintainer-lane handling, and contribution intake health. |

## Gittensor Context

Gittensory reads the signals that affect contribution quality: registered repo lanes, official miner context, open PR pressure, linked issue expectations, local validation evidence, and maintainer friction. It turns those into MCP/API guidance and sanitized GitHub App output.

## Guardrails

Gittensory is not a Gittensor frontend, public leaderboard, wallet tool, or auto-review bot. Public GitHub output stays sanitized. Private scoreability and reward/risk context stays in authenticated MCP/API surfaces.
