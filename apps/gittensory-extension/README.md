# Gittensory browser extension

Manifest V3 scaffold that augments GitHub pull request and issue pages with private Gittensory context. Intelligence stays on the Gittensory API and GitHub App; the extension only calls `GET /v1/extension/pull-context`.

## Permissions

| Permission | Why |
| --- | --- |
| `storage` | Persist API origin (sync) and extension session token (local only). |
| `https://github.com/*` | Inject the private overlay on matching PR and issue pages. |
| `https://gittensory-api.aethereal.dev/*` | Call the production Gittensory API with the extension session bearer token. |

The extension does **not** request `tabs`, `scripting`, broad `<all_urls>`, or GitHub API access. It does not read page HTML for diffs, post comments, or apply labels.

For local API development, load an unpacked build and add your dev API origin under `host_permissions` in `manifest.json` (for example `http://127.0.0.1:8787/*`).

## Authentication

1. Sign in to the control panel via GitHub OAuth (browser cookie session).
2. As a maintainer/owner/operator, create an extension token on `/extension` (`POST /v1/auth/extension/session`).
3. Paste the `gts_*` token into extension options.

Extension tokens are scoped to `extension:pull_context` and may only call `/v1/extension/pull-context` plus logout. They cannot remint tokens or access decision packs, app dashboards, or static API tokens.

## Source upload

`EXTENSION_SOURCE_UPLOAD_ENABLED` is `false` in `overlay-safety.js`. The extension never uploads repository source; it consumes API metadata only.

## Public / private boundaries

Overlay text is redacted client-side when it matches forbidden maintainer-only terms (wallet, hotkey, payout, farming, private reviewability, public score estimate, and similar). The API response is private maintainer context and must not be treated as public GitHub output.

## Build

From the repo root:

```sh
npm run extension:build
```

This copies the extension into `apps/gittensory-extension/dist/package` and zips it to `apps/gittensory-ui/public/downloads/gittensory-extension.zip`.

## Tests

Extension logic is covered by Vitest unit tests under `test/unit/extension-*.test.ts` (URL detection, auth failure handling, overlay redaction).
