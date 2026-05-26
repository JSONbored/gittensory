# GitHub App Setup

The GitHub App is the maintainer/install surface. GitHub OAuth is the MCP user-auth surface.

## Basic Fields

Use these values:

| Field | Value |
| --- | --- |
| Homepage URL | `https://gittensory.aethereal.dev` |
| Webhook URL | `${GITTENSORY_API_URL}/v1/github/webhook` |
| Webhook active | enabled |
| SSL verification | enabled |
| Device Flow | enabled |

`GITTENSORY_API_URL` is the private API origin for the deployed backend. Do not use the GitHub Pages docs domain for webhooks; Pages only serves static docs.

Use a generated webhook secret and set the same value in Cloudflare as `GITHUB_WEBHOOK_SECRET`.

## Required Repository Permissions

| Permission | Access | Why |
| --- | --- | --- |
| Metadata | Read | Required for repository identity and repository events. |
| Pull requests | Read | Required for PR metadata and webhook events. |
| Issues | Write | Required to post the sticky PR comment and apply the maintainer-configured label. |

Optional:

| Permission | Access | Why |
| --- | --- | --- |
| Checks | Write | Only needed if minimal check runs are explicitly enabled. |
| Contents | Read | Only needed if a future feature reads repository files directly through the App. |

## Required Events

Subscribe to:

- Pull request
- Issues
- Repository

If GitHub shows `Installation target`, select it. Some installation-related events are not always shown as normal selectable event rows; Gittensory should not block health on event names that are hidden in the app UI.

## Default Visibility

Gittensory inspects PR webhooks quietly first. It publishes a public surface only when the PR author is confirmed through the official Gittensor API.

Default visible behavior:

- non-miner authors: no comment, no label, no check
- bot authors: no comment, no label, no check
- maintainer-associated authors: no public output unless `includeMaintainerAuthors=true`
- confirmed miners: one sticky public-safe comment plus the configured label, defaulting to `gittensor`

Check runs default to off. If enabled later, they stay minimal and do not include private reviewability, scoring, wallet, hotkey, or reward/risk context.

## Install Or Repair

1. Update the GitHub App permissions and events.
2. Reinstall the app or approve the changed permissions.
3. Select the repos Gittensory should inspect.
4. Trigger installation-health refresh:

```sh
curl -X POST "$GITTENSORY_API_URL/v1/internal/jobs/refresh-installation-health/run" \
  -H "Authorization: Bearer $INTERNAL_JOB_TOKEN"
```

5. Check health:

```sh
curl "$GITTENSORY_API_URL/v1/readiness" \
  -H "Authorization: Bearer $GITTENSORY_API_TOKEN"
```

Healthy app installation state should remove the readiness warning about GitHub App installations needing attention.

## Marketplace Readiness

Before Marketplace submission, add:

- public docs URL
- support contact
- privacy policy
- terms page if needed
- clear setup flow
- valid webhook and install diagnostics

Do not submit until the privacy, support, terms, install diagnostics, and public setup flow are complete.
