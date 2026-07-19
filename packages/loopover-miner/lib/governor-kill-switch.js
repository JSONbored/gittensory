// Governor kill-switch gate (#2341). Resolves whether miner write activity is currently halted (globally, via
// env, or for one repo, via its .loopover-miner.yml MinerGoalSpec) and records STATE TRANSITIONS to the
// append-only governor ledger. Every-check allow/deny recording for a real write action is the fail-closed
// Governor chokepoint's job (#2340), which consults this module first in its "safest wins" precedence.
import { buildMinerKillSwitchTransitionGovernorLedgerEvent, isGlobalMinerKillSwitch, isMinerKillSwitchActive, resolveMinerKillSwitch, } from "@loopover/engine";
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
/**
 * Record a kill-switch state transition to the governor ledger. No-op (returns null, appends nothing) when the
 * scope has not actually changed since the previous check — callers own tracking the previous scope (in-memory
 * or persisted); this module holds no state of its own.
 */
export function recordMinerKillSwitchTransition(input, options = {}) {
    const event = buildMinerKillSwitchTransitionGovernorLedgerEvent(input);
    if (!event)
        return null;
    const append = options.append ?? appendGovernorEvent;
    // The engine's own GovernorLedgerEvent type allows an explicit `repoFullName: undefined`/`payload: undefined`
    // value (not just omission); this module's AppendGovernorEventInput is narrower (never an explicit
    // `undefined`, only omitted) under this repo's `exactOptionalPropertyTypes`. The real value here is always
    // `string | null` (built via `?? null` in buildMinerKillSwitchTransitionGovernorLedgerEvent), so the cast is
    // safe -- only the declared type is wider than the actual runtime shape.
    return append(event);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3Ita2lsbC1zd2l0Y2guanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJnb3Zlcm5vci1raWxsLXN3aXRjaC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSw4R0FBOEc7QUFDOUcsd0dBQXdHO0FBQ3hHLDJHQUEyRztBQUMzRyx1R0FBdUc7QUFFdkcsT0FBTyxFQUNMLGlEQUFpRCxFQUNqRCx1QkFBdUIsRUFDdkIsdUJBQXVCLEVBQ3ZCLHNCQUFzQixHQUV2QixNQUFNLGtCQUFrQixDQUFDO0FBQzFCLE9BQU8sRUFBRSxtQkFBbUIsRUFBMkQsTUFBTSxzQkFBc0IsQ0FBQztBQVlwSDs7O0dBR0c7QUFDSCxNQUFNLFVBQVUsb0JBQW9CLENBQUMsUUFBbUMsRUFBRTtJQUN4RSxNQUFNLEdBQUcsR0FBRyxLQUFLLENBQUMsR0FBRyxJQUFJLE9BQU8sQ0FBQyxHQUFHLENBQUM7SUFDckMsTUFBTSxNQUFNLEdBQUcsdUJBQXVCLENBQUMsR0FBRyxDQUFDLENBQUM7SUFDNUMsTUFBTSxLQUFLLEdBQUcsc0JBQXNCLENBQUMsRUFBRSxNQUFNLEVBQUUsVUFBVSxFQUFFLEtBQUssQ0FBQyxVQUFVLEVBQUUsQ0FBQyxDQUFDO0lBQy9FLE9BQU8sRUFBRSxLQUFLLEVBQUUsTUFBTSxFQUFFLHVCQUF1QixDQUFDLEtBQUssQ0FBQyxFQUFFLENBQUM7QUFDM0QsQ0FBQztBQVNEOzs7O0dBSUc7QUFDSCxNQUFNLFVBQVUsK0JBQStCLENBQzdDLEtBQTJDLEVBQzNDLFVBQWlGLEVBQUU7SUFFbkYsTUFBTSxLQUFLLEdBQUcsaURBQWlELENBQUMsS0FBSyxDQUFDLENBQUM7SUFDdkUsSUFBSSxDQUFDLEtBQUs7UUFBRSxPQUFPLElBQUksQ0FBQztJQUN4QixNQUFNLE1BQU0sR0FBRyxPQUFPLENBQUMsTUFBTSxJQUFJLG1CQUFtQixDQUFDO0lBQ3JELDhHQUE4RztJQUM5RyxtR0FBbUc7SUFDbkcsMkdBQTJHO0lBQzNHLDZHQUE2RztJQUM3Ryx5RUFBeUU7SUFDekUsT0FBTyxNQUFNLENBQUMsS0FBaUMsQ0FBQyxDQUFDO0FBQ25ELENBQUMifQ==