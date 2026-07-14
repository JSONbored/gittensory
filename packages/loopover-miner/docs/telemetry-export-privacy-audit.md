# Telemetry / export privacy audit — AMS cross-tenant leakage

Field-level review of every telemetry / export / metrics surface AMS emits
(`packages/loopover-miner/lib`), documenting which fields would leak cross-tenant information if AMS were
hosted as-is, with a remediation category per flagged field. This is the findings deliverable for
**#5219**; it is the AMS counterpart to ORB's #4893 privacy pass and a sibling of the singleton-state
audit in [`global-singleton-tenant-audit.md`](./global-singleton-tenant-audit.md) (#5218). **Audit and
documentation only** — no redaction/aggregation/partitioning is implemented here; each is its own
follow-up.

> The paths below are the post-rebrand `loopover-*` names for what #5219 calls `portfolio-dashboard.ts` /
> `orb-export.ts` / the miner-prediction metrics (they are `.js` in the miner package).

## Remediation-category key

- **redact** — drop or hash the field before it can be exposed.
- **aggregate** — expose only a roll-up (counts/rates), never the per-item row.
- **partition per-tenant** — the field is legitimate *within* a tenant but a tenant must only ever see its
  own; the surface (and its backing store) must be tenant-scoped.

## Summary

The surfaces split cleanly by how much identity they already strip:

1. **`orb-export.js` is the model** — it already HMAC-anonymizes repo/PR identifiers (`repoHash`/`prHash`)
   and buckets the reason (`reasonBucket`), so its *fields* are privacy-shaped. Its one hosted-context
   flaw is that the anonymization secret is **per-machine/per-store**, so a shared store would give every
   tenant the same secret and make hashes cross-tenant-correlatable.
2. **`portfolio-dashboard.js` and `prediction-ledger.js` carry raw identifiers** — `repoFullName`, and in
   the prediction ledger also `targetId` (issue/PR) and `headSha` (commit) — which directly name another
   tenant's work if the surface is shared or aggregated.
3. **The metrics renderers (`metrics-cli.js`, `governor-metrics-cli.js`) already aggregate** — their
   *output* carries no identifiers (Prometheus counters keyed only by `conclusion`, or numeric governor
   counters). Their leak is upstream: they read a **process-global, non-tenant-scoped store** (the #5218
   singletons), so a shared store mixes every tenant's numbers into one aggregate.

The dominant remediation is **partition per-tenant**, and for the aggregate surfaces it is inherited
directly from #5218's store-scoping — this audit does not re-open that, it depends on it.

## Findings by surface

### `lib/orb-export.js` — outcome export (`OrbExportRow`) — already anonymized

| Field (line) | Current contents | Leak if hosted as-is | Remediation |
| --- | --- | --- | --- |
| `repoHash` (71), `prHash` (72) | `hmacAnonymize(repoFullName / repoFullName:prNumber, secret)` — 256-bit HMAC | The secret is per-store/per-machine (`getOrCreateAnonSecret`, 108). A **shared** store gives all tenants one secret → identical repos hash identically across tenants, so hashes become cross-tenant-**correlatable** (and dictionary-attackable against public repo names). | **partition per-tenant** — a per-tenant secret/salt so hashes are not comparable across tenants. |
| `reasonBucket` (74) | bucketed reason string (`"none"` when absent) | Already a coarse bucket, not free text. | already **aggregate** — safe. |
| `decision` (73), `closedAt` (75) | outcome decision + timestamp | Low sensitivity alone; combined with a correlatable `repoHash` + time could aid correlation. | resolved by fixing `repoHash` above. |

`orb-export` is otherwise the pattern the other surfaces should follow (hash identifiers, bucket
reasons) — the only change it needs for hosting is a per-tenant secret.

### `lib/portfolio-dashboard.js` — operator dashboard (`PortfolioRepoSummary` / `PortfolioDashboardSummary`)

| Field (`.d.ts` line) | Current contents | Leak if hosted as-is | Remediation |
| --- | --- | --- | --- |
| `PortfolioRepoSummary.repoFullName` (2) | raw `owner/repo` | A shared/aggregated dashboard names every tenant's repos. | **partition per-tenant** (a tenant sees only its own repos); **redact** in any cross-tenant roll-up. |
| `byStatus` / `total` (3–4), `PortfolioDashboardSummary.total` / `oldestQueuedAgeMs` (8–11) | per-repo + top-line queue counts | Per-repo counts inherit the `repoFullName` leak; a shared top-line total leaks aggregate volume across tenants. | **partition per-tenant**. |

### `lib/prediction-ledger.js` — prediction ledger (`PredictionLedgerEntry`) — richest identifiers

| Field (`.d.ts` line) | Current contents | Leak if hosted as-is | Remediation |
| --- | --- | --- | --- |
| `repoFullName` (4) | raw `owner/repo` | Names another tenant's repo. | **partition per-tenant**. |
| `targetId` (5), `headSha` (6) | issue/PR number, commit SHA | Reveals the *specific* item/commit another tenant is working on. | **partition per-tenant** (or **redact** the SHA in any shared view). |
| `conclusion` (7), `pack` (8), `readinessScore` (9), `blockerCodes` (10), `warningCodes` (11) | per-item outcome detail | Raw rows expose another tenant's outcomes; the codes are aggregatable but the rows are not. | **partition** the rows; **aggregate** for any cross-tenant metric. |
| `id` (2), `ts` (3), `engineVersion` (12) | bookkeeping / global engine version | Low sensitivity (engine version is global infra). | none. |

### `lib/metrics-cli.js` + `packages/loopover-engine/src/miner-prediction-metrics.ts` — prediction metrics

| Surface | Current contents | Leak if hosted as-is | Remediation |
| --- | --- | --- | --- |
| `renderMinerPredictionMetrics` (Prometheus) over `MinerPredictionMetricRow = { conclusion, correct }` (miner-prediction-metrics.ts:26) | calibration counters keyed only by `conclusion`, summed `totalByConclusion` — **no identifiers** | The *output* is already identifier-free and aggregated (safe). But `collectPredictionMetricRows(ledger)` reads the whole prediction ledger, so a **shared** ledger mixes all tenants' calibration into one number. | output is **aggregate** (safe); the leak is the shared input — **partition per-tenant** the ledger it reads (inherited from #5218). |

### `lib/governor-metrics-cli.js` — governor metrics (`GovernorCapUsage` / `GovernorRateLimitState`)

| Field | Current contents | Leak if hosted as-is | Remediation |
| --- | --- | --- | --- |
| `GovernorCapUsage.budgetSpent` / `turnsTaken` / `elapsedMs` (budget-cap.ts:26) | numeric run usage | No identifiers, but read from the process-global governor-state singleton (#5218) → a shared state aggregates every tenant's usage/activity volume. | **aggregate** / **partition per-tenant** (tie usage to a tenant). Low PII. |
| `GovernorRateLimitState.buckets` / `backoffAttempts` (governor-state.d.ts:3) | write-rate-limit counters | Same shared-singleton aggregation as above. | **partition per-tenant** (inherited from #5218). |
| `listRecentOwnSubmissions` / `ListRecentOwnSubmissionsFilter.repoFullName` (governor-state.d.ts:9,35), `load/saveReputationHistory(repoFullName)` (32,33) | recent-submission + reputation records keyed by raw `repoFullName` | A shared governor state exposes another tenant's submission history and per-repo reputation. | **partition per-tenant**. |

## Safe as-is

- The **metrics/Prometheus output itself** (`renderMinerPredictionMetrics`) — aggregated, no identifiers.
  The Prometheus label/HELP escaping (`escapeLabelValue`, `escapeHelpText`) is a correctness safeguard,
  not a privacy one, but confirms conclusion strings can't break out of the exposition format.
- `engineVersion`, ledger `id`/`ts` bookkeeping fields — global/non-identifying.

## Prioritized follow-up seeds (each its own issue; tenancy-boundary ones maintainer-owned)

- [ ] **High — per-tenant anonymization secret for `orb-export` (redact→partition):** derive the export
  `getOrCreateAnonSecret` per tenant so `repoHash`/`prHash` are not cross-tenant-correlatable. The
  smallest standalone fix; the field shapes are already right.
- [ ] **High — partition the dashboard + prediction surfaces (`portfolio-dashboard.js`,
  `prediction-ledger.js`):** ensure a tenant only ever sees its own `repoFullName` / `targetId` /
  `headSha` / outcome rows; redact SHAs in any shared view. Depends on #5218's store-scoping.
- [ ] **High — tenant-scope the aggregate inputs (`metrics-cli.js`, `governor-metrics-cli.js`):** the
  *outputs* are fine; scope the prediction ledger and governor state they read so cross-tenant numbers
  don't merge. **Inherited from #5218 — do not re-open store scoping here.**
- [ ] **Cross-ref — governor reputation/submission history (`governor-state`):** the
  `listRecentOwnSubmissions` / reputation surfaces keyed by `repoFullName` are a tenancy-boundary control;
  their partitioning should get the same maintainer-review bar as #5218's kill-switch redesign.
