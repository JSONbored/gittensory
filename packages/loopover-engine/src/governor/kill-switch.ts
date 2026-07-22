// Governor kill-switch (#2341): the emergency-halt primitive every write-adjacent governor decision consults
// FIRST, before any other calculator. Two independent triggers compose into one scope: a GLOBAL env-level
// switch that halts every repo at once, and a PER-REPO switch (from `.loopover-miner.yml`'s MinerGoalSpec
// `killSwitch.paused` field) that halts only its own repo's queue while leaving the rest of the fleet running.
// Mirrors `src/settings/agent-execution.ts`'s `isGlobalAgentPause` truthy-string idiom for the review-stack's
// own kill-switch (#776) — a parallel mechanism for the miner's own local runtime, not the same one.
//
// DETECTOR ONLY — no IO, no persistence. Composing this with the other pure calculators into one fail-closed
// allow/deny verdict (and recording every CHECK, not just a transition) is the Governor chokepoint's job
// (#2340), which consults this module first in its "safest wins" precedence.

import type { GovernorLedgerEvent } from "../governor-ledger.js";

/** Truthy-string idiom shared with `isGlobalAgentPause` (`src/settings/agent-execution.ts`) — same accepted
 *  literal set, so an operator only needs to remember one convention across both kill-switches. */
const TRUTHY_ENV_VALUE = /^(1|true|yes|on)$/i;

/** Env var an operator sets to halt ALL miner write activity, across every repo, immediately. */
export const MINER_KILL_SWITCH_ENV_VAR = "LOOPOVER_MINER_KILL_SWITCH";

/** Which trigger (if any) is currently halting miner write activity for a given repo. */
export type MinerKillSwitchScope = "global" | "repo" | "none";

/**
 * True when the operator's global env-level kill-switch is set. Mirrors `isGlobalAgentPause`'s idiom exactly
 * (case-insensitive `1`/`true`/`yes`/`on`) — absence or any other value reads as not tripped. This function
 * does not itself fail closed; the caller composing it into a decision (the Governor chokepoint) is
 * responsible for that.
 */
export function isGlobalMinerKillSwitch(env: Record<string, string | undefined>): boolean {
  return TRUTHY_ENV_VALUE.test(env[MINER_KILL_SWITCH_ENV_VAR] ?? "");
}

/**
 * Resolve which kill-switch scope (if any) is active for a repo. Pure and stateless: identical inputs always
 * yield the identical scope, so toggling either input off on the next call immediately reflects "resumed" with
 * no residual state here to corrupt — any queue/attempt state a caller holds is untouched by this resolution.
 * Precedence: a global halt always reports as `"global"`, regardless of the per-repo flag (never masked); a
 * per-repo pause alone is sufficient to halt just that repo.
 */
export function resolveMinerKillSwitch(input: { global: boolean; repoPaused?: boolean | null | undefined }): MinerKillSwitchScope {
  if (input.global) return "global";
  if (input.repoPaused === true) return "repo";
  return "none";
}

/** True for any active scope (`"global"` or `"repo"`) — false only for `"none"`. */
export function isMinerKillSwitchActive(scope: MinerKillSwitchScope): boolean {
  return scope !== "none";
}

/**
 * Governor-ledger row for a kill-switch STATE TRANSITION (#2341's "state changes are themselves recorded"
 * deliverable) — call only when the scope actually changed since the previous check, not on every check (every
 * check's allow/deny for a real write action is the Governor chokepoint's job, #2340, not this primitive's).
 * Returns `null` when there is no transition, so a caller can unconditionally call this each check and only
 * append when it returns non-null.
 */
export function buildMinerKillSwitchTransitionGovernorLedgerEvent(input: {
  repoFullName?: string | null | undefined;
  actionClass: string;
  previousScope: MinerKillSwitchScope;
  scope: MinerKillSwitchScope;
}): GovernorLedgerEvent | null {
  if (input.previousScope === input.scope) return null;
  const tripped = isMinerKillSwitchActive(input.scope);
  return {
    eventType: "kill_switch",
    repoFullName: input.repoFullName ?? null,
    actionClass: input.actionClass,
    decision: tripped ? "tripped" : "resumed",
    reason: tripped ? `${input.scope}_kill_switch_engaged` : `${input.previousScope}_kill_switch_cleared`,
    payload: { previousScope: input.previousScope, scope: input.scope },
  };
}

/** Same literal set as ORB's hosted `PagerDutySeverity` (`src/services/notify-pagerduty.ts`) — kept as a local
 *  literal union rather than importing that module, since it lives in the main app, not this shared package. */
export type MinerKillSwitchPagerDutySeverity = "critical" | "error" | "warning" | "info";

/** Pure PagerDuty alert payload for a kill-switch TRIP (#7666). Never built for a resume — clearing a halt is
 *  relief, not an incident. */
export type MinerKillSwitchPagerDutyAlert = {
  repoFullName: string | null;
  scope: MinerKillSwitchScope;
  actionClass: string;
  summary: string;
  severity: MinerKillSwitchPagerDutySeverity;
  dedupKey: string;
  customDetails: Record<string, unknown>;
};

/**
 * Build the PagerDuty alert payload for a kill-switch TRIP transition (#7666) — the paging counterpart to
 * {@link buildMinerKillSwitchTransitionGovernorLedgerEvent}, sharing its exact "no-op unless the scope actually
 * changed" gate, but narrower: it additionally returns `null` on a transition INTO `"none"` (a resume), since
 * paging on "the halt cleared" would be noise, not an incident that needs a human. DETECTOR ONLY — no IO, same
 * as this whole module: `packages/loopover-miner/lib/governor-kill-switch.ts` performs the actual PagerDuty
 * Events API v2 call, mirroring how it (not this module) also performs the ledger IO for the sibling ledger-event
 * builder above. `dedupKey` intentionally omits `actionClass` — a repo/scope kill-switch trip is one incident
 * regardless of which action class first observed it, so PagerDuty's own dedup_key coalescing collapses repeats
 * into the same incident instead of opening a new one per action class.
 */
export function buildMinerKillSwitchPagerDutyAlert(input: {
  repoFullName?: string | null | undefined;
  actionClass: string;
  previousScope: MinerKillSwitchScope;
  scope: MinerKillSwitchScope;
}): MinerKillSwitchPagerDutyAlert | null {
  if (input.previousScope === input.scope) return null;
  if (!isMinerKillSwitchActive(input.scope)) return null;
  const repoFullName = input.repoFullName ?? null;
  const target = repoFullName ?? "global";
  return {
    repoFullName,
    scope: input.scope,
    actionClass: input.actionClass,
    summary: `AMS miner kill-switch tripped (${input.scope}) — ${input.actionClass} halted for ${target}`,
    severity: "critical",
    dedupKey: `miner_kill_switch_tripped:${input.scope}:${target}`,
    customDetails: { scope: input.scope, previousScope: input.previousScope, repoFullName, actionClass: input.actionClass },
  };
}
