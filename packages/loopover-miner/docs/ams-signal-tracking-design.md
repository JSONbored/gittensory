# AMS signal-tracking design — the #7982 shared calibration module and what AMS records into it

Design doc for **#7982**, the "extract a shared, deployment-agnostic calibration/signal-tracking module for
ORB + AMS" foundation issue under the false-positive/self-correction roadmap (#7980). Covers: where the shared
primitive lives, the exact shape of what AMS now writes into it, and — the explicit gap this doc exists to
name — what AMS still does **not** write, and why.

## The shared primitive

`packages/loopover-engine/src/calibration/signal-tracking.ts` — pure, storage-agnostic, mirrors
`src/review/auto-tune.ts`'s own `FlagStore`-injection precedent:

- `RuleFiredEvent` — a deterministic rule firing against a target (`ruleId`, `targetKey`, `outcome`,
  `occurredAt`, optional `metadata`). Host-defined strings throughout; the engine module never parses either.
- `HumanOverrideEvent` — a human's later, explicit judgment on a specific prior firing (`"reversed"` — the
  rule was wrong — or `"confirmed"` — it was right).
- `SignalStore` — the injected storage seam (`recordRuleFired`, `recordHumanOverride`, `queryRuleHistory`).
- `computeRulePrecision` / `computeRuleRepeatCount` — pure functions over already-fetched event lists; the
  primitives #7983 (same-rule repeat alarm) and #7984 (per-rule precision tracking) build on directly.

Two adapters implement `SignalStore`, each wrapping existing storage rather than inventing new tables:

- **ORB**: `src/review/signal-tracking-wire.ts`, wrapping `audit_events` (via `recordAuditEvent` /
  `listAuditEventsByType`, `src/db/repositories.ts`). `ruleId` is folded into `event_type` as
  `signal.rule_fired:<ruleId>` / `signal.human_override:<ruleId>`, keeping a per-rule history query an
  efficient index range scan (`audit_events_type_created_idx`) instead of a metadata scan.
- **AMS**: `packages/loopover-miner/lib/signal-tracking-store.ts`, wrapping the miner's local append-only
  `event-ledger.ts` under two new event types (`signal_rule_fired`, `signal_human_override`). No indexed
  per-rule query exists on this store, so `queryRuleHistory` scans the whole local ledger and filters
  client-side — the same pattern `calibration-cli.ts`'s `toOutcomeRecords` already uses for that same ledger.
  Fine at AMS's bounded, single-operator local volume; not a hosted-scale query shape.

## What AMS now records (live, not deferred)

`packages/miner-lib/discover-cli.ts`'s real (non-`--dry-run`) run wires the eligibility filter
(`contribution-profile-filter.ts`'s `filterCandidatesByProfiles`) to `recordRuleFired`: every candidate the
filter excludes writes one event, `ruleId` = the exclusion reason (`exclusion_label`,
`missing_eligibility_label`, `conflicting_signals`, `excluded_assignee` — see
`ELIGIBILITY_EXCLUSION_REASONS`), `targetKey` = `<owner>/<repo>#issue-<N>`, `outcome` = `"exclude"`.

Deliberately **not** wired on `--dry-run`: a dry run previews what a real run would do (it already uses a
no-op portfolio-queue store for the same reason) and must not itself contribute real data to a future
precision report. Deliberately best-effort: a store-open failure or a single event's write failure never
aborts discovery, matching every other optional store in this file (policy caches, ranked-candidates
snapshot).

This closes the exact gap #7982's own audit found: `contribution-profile-filter.ts` was previously a 100%
pure function with zero persistence — when a rule excluded a candidate, nothing recorded that decision at
all, so there was no way to later ask "how often was this exclusion actually right?"

## What AMS still does not record — the human-override gap

`recordHumanOverride` exists on the interface and the AMS adapter implements it correctly, but **nothing in
AMS calls it yet.** This is a real, known gap, not an oversight in scope:

ORB's human-override signal (see `src/review/outcomes-wire.ts`'s `recordReversalSignals`) has a natural
trigger: a human directly acts on the exact artifact the bot produced (reopens a bot-closed PR, reverts a
bot-merged one) — the same PR, a GitHub-native action, unambiguous provenance.

AMS's eligibility exclusion has no equivalent natural trigger today. Excluding a candidate means AMS never
even attempts the issue — there is no AMS-authored PR, no AMS-facing artifact a human could act on to signal
"you were wrong to skip this." Discovering that an exclusion was wrong currently requires an operator to
notice, out-of-band, that AMS skipped a genuinely-eligible issue (e.g. by reading `discover --json`'s
`excluded` field themselves) — and nothing today captures that observation back into the ledger.

**This is explicitly out of scope for #7982** (foundation only) but is the concrete, actionable follow-up a
future sub-issue should own. Two candidate designs, neither implemented here:

1. **Operator-driven**: a `loopover-miner discover mark-eligible <repo>#<issue>` command that looks up the
   most recent `signal_rule_fired` event for that target and writes a matching `recordHumanOverride("reversed")`
   — cheap, but requires an operator to actually run it.
2. **Signal-driven**: if a repo's `ContributionProfile` is later re-extracted (profiles are re-resolved
   periodically) and an issue that was previously excluded would now be *kept* under the fresh profile, treat
   that transition as an implicit `"reversed"` signal for the original exclusion. Requires diffing two
   `filterCandidatesByProfiles` runs over time, which discover-cli.ts does not currently retain.

Either design is a real, scoped follow-up issue, not a blocking dependency of #7983/#7984/#7986 — both of
those can compute meaningful repeat-count/precision reports from `recordRuleFired` data alone; precision
reports will simply show `decided: 0, precision: null` for every AMS rule until an override path exists,
which `computeRulePrecision`'s own contract already represents correctly (unknown stays unknown, never
coerced to "always right").
