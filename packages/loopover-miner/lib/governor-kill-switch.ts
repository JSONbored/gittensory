// Governor kill-switch gate (#2341). Resolves whether miner write activity is currently halted (globally, via
// env, or for one repo, via its .loopover-miner.yml MinerGoalSpec) and records STATE TRANSITIONS to the
// append-only governor ledger. Every-check allow/deny recording for a real write action is the fail-closed
// Governor chokepoint's job (#2340), which consults this module first in its "safest wins" precedence.
//
// #7666: a TRIP also pages via the same PagerDuty Events API v2 path ORB uses (`src/services/notify-pagerduty.ts`
// / LOOPOVER_ENABLE_PAGERDUTY + PAGERDUTY_ROUTING_KEY), so a kill-switch engage is not ledger-only. Resume
// stays silent -- clearing a halt must not wake anyone. The page is best-effort and never throws: a paging
// failure must never block the ledger write or the mid-attempt abandon that depends on it.

import {
  buildMinerKillSwitchPagerDutyAlert,
  buildMinerKillSwitchTransitionGovernorLedgerEvent,
  isGlobalMinerKillSwitch,
  isMinerKillSwitchActive,
  resolveMinerKillSwitch,
  type MinerKillSwitchPagerDutyAlert,
} from "@loopover/engine";
import type { MinerKillSwitchScope } from "@loopover/engine";
import { appendGovernorEvent } from "./governor-ledger.js";
import type { AppendGovernorEventInput, GovernorLedgerEntry } from "./governor-ledger.js";

export type CheckMinerKillSwitchInput = {
  repoPaused?: boolean;
  env?: Record<string, string | undefined>;
};

export type CheckMinerKillSwitchResult = {
  scope: MinerKillSwitchScope;
  active: boolean;
};

/**
 * Resolve the current kill-switch scope for a repo from process env plus a per-repo paused flag (typically
 * `MinerGoalSpec.killSwitch.paused` from the repo's parsed `.loopover-miner.yml`).
 */
export function checkMinerKillSwitch(input: CheckMinerKillSwitchInput = {}): CheckMinerKillSwitchResult {
  const env = input.env ?? process.env;
  const global = isGlobalMinerKillSwitch(env);
  const scope = resolveMinerKillSwitch({ global, repoPaused: input.repoPaused });
  return { scope, active: isMinerKillSwitchActive(scope) };
}

export type RecordMinerKillSwitchTransitionInput = {
  repoFullName?: string;
  actionClass: string;
  previousScope: MinerKillSwitchScope;
  scope: MinerKillSwitchScope;
};

export type NotifyMinerKillSwitchTrip = (
  alert: MinerKillSwitchPagerDutyAlert,
  env: Record<string, string | undefined>,
) => void | Promise<void>;

const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";
const ROUTING_KEY_RE = /^[a-f0-9]{32}$/i;
const TRUTHY_ENV = /^(1|true|yes|on)$/i;

function envString(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function pagerDutyFailMessage(error: unknown): string {
  // Prefer Error.message when present; otherwise coerce. Single helper so both sync and async
  // failure paths share one branch surface for Codecov patch.
  return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}

function warnKillSwitchPagerDutyFailed(repo: string, error: unknown): void {
  console.warn(JSON.stringify({ event: "kill_switch_pagerduty_failed", repo, message: pagerDutyFailMessage(error) }));
}

/**
 * Miner-side mirror of `triggerPagerDutyIncident` (#7666): same flag, same global routing key, same Events
 * API v2 enqueue. No D1 audit/cooldown (miner has no Worker Env) -- PagerDuty's own `dedup_key` still
 * coalesces duplicate incidents. Best-effort: never throws.
 */
export async function notifyMinerKillSwitchPagerDuty(
  alert: MinerKillSwitchPagerDutyAlert,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!TRUTHY_ENV.test((env.LOOPOVER_ENABLE_PAGERDUTY ?? "").trim())) return;
  const routingKey = envString(env, "PAGERDUTY_ROUTING_KEY");
  if (!routingKey || !ROUTING_KEY_RE.test(routingKey)) return;

  try {
    const response = await fetch(PAGERDUTY_EVENTS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routing_key: routingKey,
        event_action: "trigger",
        dedup_key: alert.dedupKey,
        payload: {
          summary: alert.summary.slice(0, 1024),
          source: "loopover-miner",
          severity: alert.severity,
          timestamp: new Date().toISOString(),
          component: alert.repoFullName,
          custom_details: alert.customDetails,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.warn(
        JSON.stringify({
          event: "kill_switch_pagerduty_failed",
          repo: alert.repoFullName,
          status: response.status,
        }),
      );
    }
  } catch (error) {
    warnKillSwitchPagerDutyFailed(alert.repoFullName, error);
  }
}

/**
 * Record a kill-switch state transition to the governor ledger. No-op (returns null, appends nothing) when the
 * scope has not actually changed since the previous check -- callers own tracking the previous scope (in-memory
 * or persisted); this module holds no state of its own. On a trip, also fires the PagerDuty page (#7666)
 * unless `notify` is overridden (tests) or the integration flag/key is unset.
 */
export function recordMinerKillSwitchTransition(
  input: RecordMinerKillSwitchTransitionInput,
  options: {
    append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry;
    notify?: NotifyMinerKillSwitchTrip;
    env?: Record<string, string | undefined>;
  } = {},
): GovernorLedgerEntry | null {
  const event = buildMinerKillSwitchTransitionGovernorLedgerEvent(input);
  if (!event) return null;
  const append = options.append ?? appendGovernorEvent;
  const recorded = append(event as AppendGovernorEventInput);

  const alert = buildMinerKillSwitchPagerDutyAlert({
    repoFullName: input.repoFullName,
    previousScope: input.previousScope,
    scope: input.scope,
  });
  if (alert) {
    const notify = options.notify ?? notifyMinerKillSwitchPagerDuty;
    const env = options.env ?? process.env;
    try {
      // Promise.resolve wraps sync returns so both sync throws and async rejects share one failure path.
      void Promise.resolve(notify(alert, env)).catch((error: unknown) => {
        warnKillSwitchPagerDutyFailed(alert.repoFullName, error);
      });
    } catch (error) {
      warnKillSwitchPagerDutyFailed(alert.repoFullName, error);
    }
  }

  return recorded;
}
