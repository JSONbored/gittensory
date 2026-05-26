---
layout: home

hero:
  name: Gittensory
  text: Private repo intelligence for Gittensor work.
  tagline: "For Gittensor miners, maintainers, and agents: MCP preflight, scoreability projections, and GitHub App review packets. Still not a Gittensor frontend."
  image:
    src: /logo.svg
    alt: Gittensory signal mark
  actions:
    - theme: brand
      text: Install MCP
      link: /guide/install
    - theme: alt
      text: GitHub App Setup
      link: /guide/github-app-setup

features:
  - title: Scoreability
    details: Current estimate, ungated potential, and near-term what-if scenarios.
  - title: Queue Pressure
    details: Open PR gates, stale branches, duplicate risk, and cleanup-first actions.
  - title: Role Context
    details: Contributor lane, maintainer lane, owner history, and repo-specific evidence.
  - title: Reviewability
    details: Private maintainer packets plus public-safe PR guidance.
  - title: Registry Signals
    details: Repo lanes, label multipliers, issue discovery, bounties, and config drift.
  - title: MCP Native
    details: Codex, Claude, Cursor, and agents get structured JSON without code upload.
---

<div class="gtn-home">
  <div class="gtn-strip">
    <div class="gtn-strip__item">
      <div class="gtn-kicker">01 / Miners</div>
      <strong>Pick work with less guesswork.</strong>
      <span>Score blockers, lane fit, stale base checks, and cleanup-first guidance.</span>
    </div>
    <div class="gtn-strip__item">
      <div class="gtn-kicker">02 / Maintainers</div>
      <strong>Review signal, not noise.</strong>
      <span>Role-aware context, duplicate risk, validation evidence, and next action.</span>
    </div>
    <div class="gtn-strip__item">
      <div class="gtn-kicker">03 / Agents</div>
      <strong>Local branch context.</strong>
      <span>Metadata-only MCP tools for Codex, Claude, Cursor, and automation.</span>
    </div>
    <div class="gtn-strip__item">
      <div class="gtn-kicker">04 / Privacy</div>
      <strong>Private by default.</strong>
      <span>No PAT storage, no source upload, no public score or wallet leakage.</span>
    </div>
  </div>

  <div class="gtn-panel">
    <section>
      <h2>Not another Gittensor frontend.</h2>
      <p>
        Gittensory is the private signal layer behind better contributions:
        official miner context, registry lanes, queue pressure, scoreability
        projections, maintainer friction, and public-safe PR packets.
      </p>
    </section>
    <section class="gtn-terminal" aria-label="Gittensory signal example">
      <div><b>lane</b><span>direct_pr / issue_discovery / maintainer</span></div>
      <div><b>score</b><span>current 0, potential visible, scenario gated</span></div>
      <div><b>risk</b><span>open PR pressure, credibility, stale base</span></div>
      <div><b>output</b><span>private MCP JSON + sanitized PR packet</span></div>
    </section>
  </div>
</div>
