# Gittensory

Gittensory is a backend-only GitHub App/API layer for Gittensor registered repositories.

It gives maintainers and serious contributors advisory signals around repository configuration,
pull requests, issues, bounty context, duplicate risk, and queue health. It does not auto-label,
comment, close, merge, or store user GitHub PATs.

The product wedge is signal, not UI. Gittensory is not a replacement frontend for Gittensor or
gittensor-hub; it is a private API and GitHub App surface that exposes evidence-backed context
other frontends usually do not show clearly.

The frontend is intentionally out of scope for this repo slice. Lovable can consume the JSON API
and OpenAPI document once the backend is deployed.

## What It Does

- Helps contributors understand which repos fit their GitHub history and which submissions need
  cleanup before they become maintainer burden.
- Helps maintainers identify noisy queues, duplicate or overlapping work, missing issue linkage,
  stale PRs, and repo config problems.
- Helps repo owners see whether their Gittensor registration, labels, and participation lane are
  likely to attract useful work.
- Exposes the same backend intelligence through a private MCP endpoint for coding agents and
  contributor tooling.
- Can publish opt-in, public-safe GitHub PR context comments for detected Gittensor contributors
  while keeping detailed trust signals in checks/API.
- Keeps the first intelligence layer deterministic and evidence-based. LLMs may summarize later,
  but core trust/ranking decisions stay rule-driven.

## Backend Stack

- Cloudflare Workers + Hono
- Cloudflare D1 + Drizzle schema/migrations
- Cloudflare Queues for async webhook/check processing
- GitHub App webhooks and check runs
- Zod schemas with generated OpenAPI JSON

## Local Setup

```bash
npm install
npm run cf-typegen
npm run db:migrate:local
npm run dev
```

Secrets are configured through Cloudflare, not committed:

```bash
wrangler secret put GITHUB_WEBHOOK_SECRET
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put GITHUB_PUBLIC_TOKEN
wrangler secret put GITTENSORY_API_TOKEN
wrangler secret put GITTENSORY_MCP_TOKEN
wrangler secret put INTERNAL_JOB_TOKEN
```

`GITHUB_PUBLIC_TOKEN` is a server-side GitHub API token used only to raise rate limits when
backfilling public registered repositories that have not installed the GitHub App. It is not a
contributor token, and Gittensory does not store user PATs.

For local development, put non-production test values in `.dev.vars`.

## API

Private beta REST endpoints use `Authorization: Bearer <GITTENSORY_API_TOKEN>`.
`/health`, signed GitHub webhooks, internal-token routes, and `/mcp` use their own auth paths.

- `GET /health`
- `GET /openapi.json`
- `GET /v1/registry/snapshot`
- `GET /v1/registry/changes`
- `GET /v1/sync/status`
- `GET /v1/readiness`
- `GET /v1/installations`
- `GET /v1/installations/:id/health`
- `GET /v1/repos`
- `GET /v1/repos/:owner/:repo`
- `GET /v1/repos/:owner/:repo/advisory`
- `GET /v1/repos/:owner/:repo/lane`
- `GET /v1/repos/:owner/:repo/workboard`
- `GET /v1/repos/:owner/:repo/queue-health`
- `GET /v1/repos/:owner/:repo/collisions`
- `GET /v1/repos/:owner/:repo/config-quality`
- `GET /v1/repos/:owner/:repo/labels/audit`
- `GET /v1/repos/:owner/:repo/settings`
- `GET /v1/repos/:owner/:repo/maintainer-packet`
- `GET /v1/repos/:owner/:repo/pulls/:number/maintainer-packet`
- `GET /v1/repos/:owner/:repo/pulls/:number/advisory`
- `GET /v1/repos/:owner/:repo/issues/:number/advisory`
- `GET /v1/contributors/:login/profile`
- `GET /v1/contributors/:login/opportunities`
- `GET /v1/contributors/:login/fit`
- `POST /v1/preflight/pr`
- `POST /v1/preflight/local-diff`
- `GET /v1/bounties`
- `GET /v1/bounties/:id/advisory`
- `POST /mcp`
- `POST /v1/github/webhook`
- `POST /v1/internal/jobs/refresh-registry`
- `POST /v1/internal/jobs/refresh-registry/run`
- `POST /v1/internal/jobs/backfill-registered-repos`
- `POST /v1/internal/jobs/backfill-registered-repos/run`
- `POST /v1/internal/jobs/generate-signal-snapshots`
- `POST /v1/internal/jobs/refresh-installation-health/run`
- `POST /v1/internal/bounties/import`
- `POST /v1/internal/repos/:owner/:repo/settings`

## Operational Readiness

Use the protected readiness endpoint before widening beta access or making the repository public:

```bash
curl -fsS "$GITTENSORY_URL/v1/readiness" \
  -H "Authorization: Bearer $GITTENSORY_API_TOKEN"
```

The response reports registry freshness, GitHub backfill state, installation health, required
secret presence, and blocking warnings. It does not expose secret values.

## MCP

`POST /mcp` exposes private-beta MCP tools over JSON-RPC/Streamable HTTP style requests.
Use `Authorization: Bearer <GITTENSORY_MCP_TOKEN>`.

Tools:

- `gittensory_get_repo_context`
- `gittensory_get_contributor_profile`
- `gittensory_find_opportunities`
- `gittensory_get_contributor_fit`
- `gittensory_preflight_pr`
- `gittensory_get_queue_health`
- `gittensory_get_collisions`
- `gittensory_get_bounty_advisory`
- `gittensory_get_registry_changes`
- `gittensory_audit_repo_labels`
- `gittensory_explain_lane`
- `gittensory_preflight_local_diff`

## GitHub App PR Intelligence

Repo comments are off by default. Enable public-safe sticky PR comments through the protected
settings endpoint:

```bash
curl -X POST "$GITTENSORY_URL/v1/internal/repos/OWNER/REPO/settings" \
  -H "Authorization: Bearer $INTERNAL_JOB_TOKEN" \
  -H "content-type: application/json" \
  --data '{"commentMode":"detected_contributors_only","publicSignalLevel":"standard"}'
```

Detailed maintainer intelligence stays in check runs and API responses. PR comments intentionally
avoid raw trust scores, rankings, wallet data, or compensation estimates.

## Validation

```bash
npm run test:ci
```
