# AMS auth/identity design — a hosted, multi-tenant login layer over the existing ORB broker

Design for **#4941**, building directly on the merged survey in
[`ams-auth-identity-research.md`](./ams-auth-identity-research.md) (#5764). That research evaluated three
approaches against loopover's existing installation-token / GitHub App infrastructure and recommended
(non-binding) **Option 1 — GitHub OAuth as the identity source, reusing ORB's self-enrollment + installation-token
broker**. This document turns that recommendation into a concrete design: the data model, the request flows, the
authorization boundary, and the phased implementation order. It is deliberately scoped to the recommended
direction rather than re-opening the option comparison.

**Boundaries (unchanged from the research's framing):** this designs a *hosted-mode* layer only. Self-host AMS
(single operator, `GITHUB_TOKEN` from env, no login) is unaffected and stays the default. The design **reuses**
`src/orb/broker.ts`'s installation-token exchange and its server-side `installation_id` binding as-is — it does
not modify, wrap, or re-derive that behavior. Where a choice is genuinely the maintainer's (session TTLs, whether
to admit non-GitHub tenants), it is called out as an open question, not decided here.

## What the layer must do (from the research)

1. Establish **tenant identity** — who is signing in.
2. Map identity → the tenant's **GitHub App installation(s)** — the unit AMS acts on.
3. **Authorize** resource access — a tenant sees only their own loops/queues/ledgers.
4. **Obtain GitHub tokens** to act — already handled by the broker; the layer feeds it, never replaces it.
5. **Session** lifecycle — issue / refresh / revoke.

## Design overview

The tenant's identity **is** their GitHub account, established via GitHub OAuth — the same authority
`src/orb/oauth.ts`'s maintainer self-enrollment already proves (that the caller is an admin of an installation's
account, verified server-side before anything is issued). Login therefore reuses the existing ownership proof; the
broker's short-lived installation-token mint is fed by it, not duplicated. Tenant scoping rides the composite-key
pattern the stores already have.

```
GitHub OAuth (identity)  ──►  installation-ownership proof (reuse src/orb/oauth.ts)
        │                                   │
        ▼                                   ▼
  tenant session                    orb_github_installations (registered=1)
  (opaque, hashed at rest)                  │
        │                                   ▼
        └──────────────►  tenant-scoped store access  ◄──  ORB broker mints GH token
                          (tenant_id on composite key)      (src/orb/broker.ts, unchanged)
```

## Data model

Two new hosted-only tables, plus one column on the existing per-tenant stores. All follow the primitives already
in the codebase — opaque tokens via `createOpaqueToken` / `hashToken` (`src/auth/security.ts`), and the
composite-key scoping introduced for forge isolation (#5563).

- **`ams_tenants`** — one row per signed-up account: `tenant_id` (PK), `github_login`, `github_user_id`,
  `created_at`, `status`. The GitHub user id (immutable) is the identity anchor; the login is display-only.
- **`ams_tenant_sessions`** — `session_id` (PK), `tenant_id` (FK), `token_hash` (SHA-256 of an opaque token,
  never the token itself — mirrors how enrollment secrets are stored), `issued_at`, `expires_at`, `revoked_at`.
  Only the hash is stored, exactly as `src/orb/broker.ts` stores the enrollment secret hash.
- **`tenant_id` on the stores** — the storage-abstraction research (#5563 / see
  [`ams-storage-abstraction-research.md`](./ams-storage-abstraction-research.md)) notes the stores already key on
  `(api_base_url, repo_full_name, …)`; `tenant_id` extends that existing composite key rather than adding a new
  scoping axis. Self-host uses a single implicit local tenant, so the column defaults to a fixed sentinel and the
  self-host path is behaviorally unchanged.

Identity → installation mapping reuses the existing `orb_github_installations` enrollment table
(`src/orb/broker.ts`) — a tenant's installations are the ones whose account they proved admin of at enrollment;
no second source of truth for "who owns this installation" is introduced.

## Flows

1. **Sign-in.** GitHub OAuth authorization-code flow → the layer learns `github_user_id`; upserts `ams_tenants`;
   issues an `ams_tenant_sessions` row (opaque token to the client, hash at rest). Reuses the OAuth machinery
   `src/orb/oauth.ts` already exercises, not a new provider.
2. **Link installation.** The tenant proves admin of the target installation's account — the same server-side
   proof `oauth.ts` self-enrollment performs — which sets/uses the `registered=1` enrollment row. Ownership is
   established once, server-side, never from a request field.
3. **Mint a GitHub token.** Unchanged: the broker exchanges the enrollment for a short-lived (~1h) installation
   token via `POST /v1/orb/token`, `installation_id` bound at issue time from the enrollment row
   (`src/orb/broker.ts`). The auth layer supplies the authenticated tenant context; the broker's contract is
   untouched.
4. **Authorize resource access.** Every hosted store read/write is filtered by the session's `tenant_id` on the
   composite key. A tenant can never name another tenant's `tenant_id` because it is taken from the server-side
   session, never the request — the same "bind from the row, not the request" property the broker already relies
   on to stop cross-installation token theft.
5. **Session lifecycle.** Sessions expire at `expires_at` and can be revoked (`revoked_at`) — e.g. on sign-out or
   when installation admin is lost. Revocation is a single-statement update the existing SQLite/D1 pattern
   supports; no long-lived credential beyond the hashed session token is introduced.

## Security properties (preserved, not re-derived)

- **GitHub remains the authority.** Installation ownership is proven exactly where it is today (`oauth.ts`,
  server-side), so the design adds no new way to claim an installation.
- **Server-side binding.** Both `installation_id` (broker) and `tenant_id` (store scope) come from server-held
  rows, never request fields — the property that closes the privilege-escalation surface the enrollment design
  already hardened.
- **Secrets stored as hashes only.** Session tokens follow the enrollment-secret precedent: opaque token to the
  client once, SHA-256 hash at rest (`src/auth/security.ts`).
- **Smallest new surface.** No new long-lived credential store, no second identity provider, no change to the
  token-mint path — consistent with the research's reason for recommending Option 1 over Options 2 and 3.

## Self-host boundary

Hosted auth is gated and off by default. Self-host AMS keeps its single-operator `GITHUB_TOKEN` path with no
login, no session table, and a fixed implicit `tenant_id`; none of the new tables or flows are reachable unless
hosted mode is explicitly configured. This mirrors how the storage abstraction keeps the local-file backend the
untouched default.

## Implementation phasing (the "initial implementation" in #4941, in order)

This PR delivers the **design**; the implementation lands as reviewable follow-up steps, each self-contained:

1. **Schema + scope column** — `ams_tenants`, `ams_tenant_sessions`, and the `tenant_id` composite-key column
   with a self-host sentinel default (behavior-identical for self-host). Pure data-layer, unit-testable.
2. **Session primitives** — issue / validate / revoke over the opaque-token + hash primitives already in
   `src/auth/security.ts`. No network, fully unit-testable.
3. **OAuth sign-in + installation link** — wire the existing OAuth/enrollment proof to tenant creation.
4. **Tenant-scoped store access** — thread the session `tenant_id` through hosted store reads/writes.

Each step is behind the hosted-mode gate, so self-host CI stays green throughout.

## Open questions (maintainer's call)

- **Session TTL / refresh policy** — fixed short TTL vs. sliding refresh; the research favored small, scoped
  sessions but left the number open.
- **Non-GitHub tenants** — whether to ever admit email/SSO tenants (research Option 2, a managed IdP *alongside*
  the broker); this design assumes GitHub-only until a concrete requirement lands, and is structured so Option 2
  attaches at the sign-in step without disturbing the broker or the store scope.
- **Row-level security vs. application-level filtering** for `tenant_id` — the storage research lists both;
  this design assumes application-level filtering from the session, with RLS as an optional hardening.
