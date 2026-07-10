# Gittensory Miner Extension

Contributor-facing browser extension scaffold for GitHub **issue** pages. It is intentionally separate from
[`apps/gittensory-extension/`](../gittensory-extension/) (the **Maintainer Overlay**), which injects private PR/issue
context for maintainers.

This package is Phase 6 scaffolding only:

- Manifest V3 with issue-page `content_scripts`
- `background.js` service worker + `content.js` message-passing shell
- Options page for local watched-repo configuration

The read-only issue-page opportunity badge is implemented in a follow-up issue after this scaffold lands.
