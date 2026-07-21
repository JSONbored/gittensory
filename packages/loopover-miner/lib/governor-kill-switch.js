// Governor kill-switch gate (#2341). Resolves whether miner write activity is currently halted (globally, via
// env, or for one repo, via its .loopover-miner.yml MinerGoalSpec) and records STATE TRANSITIONS to the
// append-only governor ledger. Every-check allow/deny recording for a real write action is the fail-closed
// Governor chokepoint's job (#2340), which consults this module first in its "safest wins" precedence.
//
// #7666: a TRIP also pages via the same PagerDuty Events API v2 path ORB uses (`src/services/notify-pagerduty.ts`
// / LOOPOVER_ENABLE_PAGERDUTY + PAGERDUTY_ROUTING_KEY), so a kill-switch engage is not ledger-only. Resume
// stays silent -- clearing a halt must not wake anyone. The page is best-effort and never throws: a paging
// failure must never block the ledger write or the mid-attempt abandon that depends on it.
import { buildMinerKillSwitchPagerDutyAlert, buildMinerKillSwitchTransitionGovernorLedgerEvent, isGlobalMinerKillSwitch, isMinerKillSwitchActive, resolveMinerKillSwitch, } from "@loopover/engine";
import { appendGovernorEvent } from "./governor-ledger.js";
/**
 * Resolve the current kill-switch scope for a repo from process env plus a per-repo paused flag (typically
 * `MinerGoalSpec.killSwitch.paused` from the repo's parsed `.loopover-miner.yml`).
 */
export function checkMinerKillSwitch(input = {}) {
    const env = input.env ?? process.env;
    const global = isGlobalMinerKillSwitch(env);
    const scope = resolveMinerKillSwitch({ global, repoPaused: input.repoPaused });
    return { scope, active: isMinerKillSwitchActive(scope) };
}
const PAGERDUTY_EVENTS_URL = "https://events.pagerduty.com/v2/enqueue";
const ROUTING_KEY_RE = /^[a-f0-9]{32}$/i;
const TRUTHY_ENV = /^(1|true|yes|on)$/i;
function envString(env, name) {
    const value = env[name];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
function pagerDutyFailMessage(error) {
    // Prefer Error.message when present; otherwise coerce. Single helper so both sync and async
    // failure paths share one branch surface for Codecov patch.
    return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
function warnKillSwitchPagerDutyFailed(repo, error) {
    console.warn(JSON.stringify({ event: "kill_switch_pagerduty_failed", repo, message: pagerDutyFailMessage(error) }));
}
/**
 * Miner-side mirror of `triggerPagerDutyIncident` (#7666): same flag, same global routing key, same Events
 * API v2 enqueue. No D1 audit/cooldown (miner has no Worker Env) -- PagerDuty's own `dedup_key` still
 * coalesces duplicate incidents. Best-effort: never throws.
 */
export async function notifyMinerKillSwitchPagerDuty(alert, env = process.env) {
    if (!TRUTHY_ENV.test((env.LOOPOVER_ENABLE_PAGERDUTY ?? "").trim()))
        return;
    const routingKey = envString(env, "PAGERDUTY_ROUTING_KEY");
    if (!routingKey || !ROUTING_KEY_RE.test(routingKey))
        return;
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
            console.warn(JSON.stringify({
                event: "kill_switch_pagerduty_failed",
                repo: alert.repoFullName,
                status: response.status,
            }));
        }
    }
    catch (error) {
        warnKillSwitchPagerDutyFailed(alert.repoFullName, error);
    }
}
/**
 * Record a kill-switch state transition to the governor ledger. No-op (returns null, appends nothing) when the
 * scope has not actually changed since the previous check -- callers own tracking the previous scope (in-memory
 * or persisted); this module holds no state of its own. On a trip, also fires the PagerDuty page (#7666)
 * unless `notify` is overridden (tests) or the integration flag/key is unset.
 */
export function recordMinerKillSwitchTransition(input, options = {}) {
    const event = buildMinerKillSwitchTransitionGovernorLedgerEvent(input);
    if (!event)
        return null;
    const append = options.append ?? appendGovernorEvent;
    const recorded = append(event);
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
            void Promise.resolve(notify(alert, env)).catch((error) => {
                warnKillSwitchPagerDutyFailed(alert.repoFullName, error);
            });
        }
        catch (error) {
            warnKillSwitchPagerDutyFailed(alert.repoFullName, error);
        }
    }
    return recorded;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3Ita2lsbC1zd2l0Y2guanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJnb3Zlcm5vci1raWxsLXN3aXRjaC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSw4R0FBOEc7QUFDOUcsd0dBQXdHO0FBQ3hHLDJHQUEyRztBQUMzRyx1R0FBdUc7QUFDdkcsRUFBRTtBQUNGLGtIQUFrSDtBQUNsSCwyR0FBMkc7QUFDM0csMkdBQTJHO0FBQzNHLDJGQUEyRjtBQUUzRixPQUFPLEVBQ0wsa0NBQWtDLEVBQ2xDLGlEQUFpRCxFQUNqRCx1QkFBdUIsRUFDdkIsdUJBQXVCLEVBQ3ZCLHNCQUFzQixHQUV2QixNQUFNLGtCQUFrQixDQUFDO0FBRTFCLE9BQU8sRUFBRSxtQkFBbUIsRUFBRSxNQUFNLHNCQUFzQixDQUFDO0FBYTNEOzs7R0FHRztBQUNILE1BQU0sVUFBVSxvQkFBb0IsQ0FBQyxRQUFtQyxFQUFFO0lBQ3hFLE1BQU0sR0FBRyxHQUFHLEtBQUssQ0FBQyxHQUFHLElBQUksT0FBTyxDQUFDLEdBQUcsQ0FBQztJQUNyQyxNQUFNLE1BQU0sR0FBRyx1QkFBdUIsQ0FBQyxHQUFHLENBQUMsQ0FBQztJQUM1QyxNQUFNLEtBQUssR0FBRyxzQkFBc0IsQ0FBQyxFQUFFLE1BQU0sRUFBRSxVQUFVLEVBQUUsS0FBSyxDQUFDLFVBQVUsRUFBRSxDQUFDLENBQUM7SUFDL0UsT0FBTyxFQUFFLEtBQUssRUFBRSxNQUFNLEVBQUUsdUJBQXVCLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQztBQUMzRCxDQUFDO0FBY0QsTUFBTSxvQkFBb0IsR0FBRyx5Q0FBeUMsQ0FBQztBQUN2RSxNQUFNLGNBQWMsR0FBRyxpQkFBaUIsQ0FBQztBQUN6QyxNQUFNLFVBQVUsR0FBRyxvQkFBb0IsQ0FBQztBQUV4QyxTQUFTLFNBQVMsQ0FBQyxHQUF1QyxFQUFFLElBQVk7SUFDdEUsTUFBTSxLQUFLLEdBQUcsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFDO0lBQ3hCLE9BQU8s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