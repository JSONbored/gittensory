// Governor kill-switch gate (#2341). Resolves whether miner write activity is currently halted (globally, via
// env, or for one repo, via its .loopover-miner.yml MinerGoalSpec) and records STATE TRANSITIONS to the
// append-only governor ledger. Every-check allow/deny recording for a real write action is the fail-closed
// Governor chokepoint's job (#2340), which consults this module first in its "safest wins" precedence.
//
// PagerDuty paging (#7666): a TRIP transition also fires a page, mirroring ORB's hosted `triggerPagerDutyIncident`
// (src/services/notify-pagerduty.ts) Events API v2 contract -- same LOOPOVER_ENABLE_PAGERDUTY flag, same
// PAGERDUTY_ROUTING_KEY, same enqueue URL/payload shape -- with the same simplification #7667's control-plane
// mirror (control-plane/src/pagerduty-notify.ts) used: no D1/Worker Env here either (the miner is a plain Node
// process), so no per-repo routing-key map and no severity-threshold/cooldown DB query; PagerDuty's own
// `dedup_key` still coalesces duplicate incidents. Best-effort: paging can never block or throw past the ledger
// write it accompanies.

import {
  buildMinerKillSwitchPagerDutyAlert,
  buildMinerKillSwitchTransitionGovernorLedgerEvent,
  isGlobalMinerKillSwitch,
  isMinerKillSwitchActive,
  resolveMinerKillSwitch,
} from "@loopover/engine";
import type { MinerKillSwitchPagerDutyAlert, MinerKillSwitchScope } from "@loopover/engine";
import { appendGovernorEvent } from "./governor-ledger.js";
import type { AppendGovernorEventInput, GovernorLedgerEntry } from "./governor-ledger.js";

const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";
// PagerDuty routing/integration keys are 32 lowercase hex characters.
const ROUTING_KEY_RE = /^[a-f0-9]{32}$/i;
const TRUTHY_ENV = /^(1|true|yes|on)$/i;

export type NotifyMinerKillSwitchPagerDuty = (
  alert: MinerKillSwitchPagerDutyAlert,
  env: Record<string, string | undefined>,
) => void | Promise<void>;

function envString(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function warnMinerKillSwitchPagerDutyFailed(dedupKey: string, error: unknown): void {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 200);
  console.warn(JSON.stringify({ event: "miner_kill_switch_pagerduty_failed", dedupKey, message }));
}

/** Miner-side mirror of ORB's `triggerPagerDutyIncident` (src/services/notify-pagerduty.ts) Events API v2
 *  contract, same simplification #7667's control-plane mirror used (no D1/Worker Env here either): same
 *  LOOPOVER_ENABLE_PAGERDUTY flag, same global PAGERDUTY_ROUTING_KEY, same enqueue URL/payload shape. PagerDuty's
 *  own dedup_key still coalesces duplicate incidents. Best-effort: never throws -- a paging failure must never
 *  block or mask the governor ledger write it is reporting on. */
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
          component: alert.repoFullName ?? "global",
          custom_details: alert.customDetails,
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      console.warn(JSON.stringify({ event: "miner_kill_switch_pagerduty_failed", dedupKey: alert.dedupKey, status: response.status }));
    }
  } catch (error) {
    warnMinerKillSwitchPagerDutyFailed(alert.dedupKey, error);
  }
}

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

export type RecordMinerKillSwitchTransitionOptions = {
  append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry;
  /** Injectable for tests; defaults to the real {@link notifyMinerKillSwitchPagerDuty} Events API v2 call. */
  notify?: NotifyMinerKillSwitchPagerDuty;
  /** Defaults to `process.env`, matching {@link notifyMinerKillSwitchPagerDuty}'s own default. */
  env?: Record<string, string | undefined>;
};

/**
 * Record a kill-switch state transition to the governor ledger. No-op (returns null, appends nothing) when the
 * scope has not actually changed since the previous check — callers own tracking the previous scope (in-memory
 * or persisted); this module holds no state of its own.
 *
 * On a TRIP (not a resume), also pages PagerDuty (#7666) via {@link notifyMinerKillSwitchPagerDuty}: the ledger
 * row is appended FIRST, then paging is fired fire-and-forget (wrapped in both a sync try/catch and a `.catch`
 * on its returned promise, so neither a synchronous throw nor an async rejection from the notify hook can ever
 * block or mask the ledger write that already landed).
 */
export function recordMinerKillSwitchTransition(
  input: RecordMinerKillSwitchTransitionInput,
  options: RecordMinerKillSwitchTransitionOptions = {},
): GovernorLedgerEntry | null {
  const event = buildMinerKillSwitchTransitionGovernorLedgerEvent(input);
  if (!event) return null;
  const append = options.append ?? appendGovernorEvent;
  const entry = append(event as AppendGovernorEventInput);

  const alert = buildMinerKillSwitchPagerDutyAlert(input);
  if (alert) {
    const notify = options.notify ?? notifyMinerKillSwitchPagerDuty;
    const env = options.env ?? process.env;
    try {
      const result = notify(alert, env);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((error: unknown) => warnMinerKillSwitchPagerDutyFailed(alert.dedupKey, error));
      }
    } catch (error) {
      warnMinerKillSwitchPagerDutyFailed(alert.dedupKey, error);
    }
  }

  return entry;
}
