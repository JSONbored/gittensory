// Rejection state machine (#4278): the missing detector + classifier that turns a closed-without-merge PR
// into a rejection-reason bucket and, for the first time, drives `renderRejectionMessage`
// (rejection-templates.js, which until now had zero callers outside its own test). Pure classification and
// content only — no GitHub calls, no network, no writes. The caller (a poller) persists the result locally.
//
// DESIGN DECISIONS (called out explicitly by #4278):
//   • "disengaged" is a per-PR OUTCOME, not a per-repo run-state. A rejection is about one PR, so it belongs
//     with the `manage-poll.js` outcome family (ready / needs-work / open), NOT `run-state.js`'s RUN_STATES
//     (idle / discovering / planning / preparing). `DISENGAGED_OUTCOME` is defined HERE and left for a poller
//     to adopt — this module deliberately does NOT mutate manage-poll.js's or run-state.js's enum as a side
//     effect (the issue explicitly warns against silently expanding another module's vocabulary).
//   • Zero-signal fallback: with no gate/duplicate signal, a rejection classifies as `maintainer_close_no_reason`
//     — the courteous, non-assuming bucket — rather than being left unclassified, so a rejection ALWAYS renders
//     a note.
//   • This surfaces the PR's terminal fields from a payload the poller already fetches (ci-poller.js's
//     `fetchHeadSha` GETs the full `/pulls/{n}` body, :155-163, and discards all but `head.sha`) via a pure
//     extractor — no second API call, and no behavioral change to the existing fetch.
import { renderRejectionMessage } from "./rejection-templates.js";
/** Per-PR terminal outcome for a rejected (closed-without-merge) PR. A poller adds this to its own outcome
 *  vocabulary alongside ready / needs-work / open. */
export const DISENGAGED_OUTCOME = "disengaged";
/**
 * Pull the terminal-outcome fields from a `GET /pulls/{n}` payload the poller already has. Pure — no API call.
 * Missing/malformed fields normalize to null/false so a partial payload never throws here.
 */
export function extractPrOutcomeFields(prPayload) {
    const p = (prPayload && typeof prPayload === "object" ? prPayload : {});
    return {
        state: typeof p.state === "string" ? p.state : null,
        merged: p.merged === true,
        mergedAt: typeof p.merged_at === "string" ? p.merged_at : null,
        closedAt: typeof p.closed_at === "string" ? p.closed_at : null,
    };
}
/**
 * True when a PR is closed WITHOUT a merge — the rejection this state machine acts on. A merged PR (even though
 * GitHub also marks it `state: "closed"`) is NOT a rejection. Pure.
 */
export function isRejectedPr(fields) {
    const f = (fields && typeof fields === "object" ? fields : {});
    return f.state === "closed" && f.merged !== true;
}
/**
 * Classify a detected rejection into one of the rejection-reason buckets from the available signal.
 * Precedence: an explicit gate close outranks a duplicate signal (the gate is the more specific, actionable
 * cause). With neither signal, defaults to `maintainer_close_no_reason` (the documented zero-signal fallback).
 * Pure.
 */
export function classifyRejectionReason(signal = {}) {
    const s = (signal && typeof signal === "object" ? signal : {});
    if (s.gateClosed === true)
        return "gate_close";
    if (s.supersededByDuplicate === true)
        return "superseded_by_duplicate";
    return "maintainer_close_no_reason";
}
/**
 * The full transition. Given a PR payload, an optional gate/duplicate signal, and the render context
 * (`{ repoFullName, prNumber }`), decide whether the PR is a rejection and, if so, produce the disengaged
 * transition: the classified reason and the rendered courtesy note (this is `renderRejectionMessage`'s first
 * real caller). Returns null when the PR is not a rejection (still open, or merged) — nothing to disengage.
 * Pure and deterministic; the caller persists `{ outcome, reason, note }` via its local event ledger.
 */
export function resolveRejection(prPayload, signal, context) {
    const fields = extractPrOutcomeFields(prPayload);
    if (!isRejectedPr(fields))
        return null;
    const reason = classifyRejectionReason(signal);
    const note = renderRejectionMessage(reason, context); // throws on malformed context — a half-note never emits
    return { outcome: DISENGAGED_OUTCOME, reason, note, fields };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicmVqZWN0aW9uLXN0YXRlLW1hY2hpbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJyZWplY3Rpb24tc3RhdGUtbWFjaGluZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSwwR0FBMEc7QUFDMUcsMEZBQTBGO0FBQzFGLDJHQUEyRztBQUMzRyw0R0FBNEc7QUFDNUcsRUFBRTtBQUNGLHFEQUFxRDtBQUNyRCw2R0FBNkc7QUFDN0csNEdBQTRHO0FBQzVHLDhHQUE4RztBQUM5Ryw0R0FBNEc7QUFDNUcsa0dBQWtHO0FBQ2xHLGtIQUFrSDtBQUNsSCxnSEFBZ0g7QUFDaEgsY0FBYztBQUNkLHVHQUF1RztBQUN2Ryw0R0FBNEc7QUFDNUcsc0ZBQXNGO0FBRXRGLE9BQU8sRUFBRSxzQkFBc0IsRUFBRSxNQUFNLDBCQUEwQixDQUFDO0FBc0JsRTtzREFDc0Q7QUFDdEQsTUFBTSxDQUFDLE1BQU0sa0JBQWtCLEdBQUcsWUFBWSxDQUFDO0FBRS9DOzs7R0FHRztBQUNILE1BQU0sVUFBVSxzQkFBc0IsQ0FBQyxTQUFrQjtJQUN2RCxNQUFNLENBQUMsR0FBRyxDQUFDLFNBQVMsSUFBSSxPQUFPLFNBQVMsS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUE0QixDQUFDO0lBQ25HLE9BQU87UUFDTCxLQUFLLEVBQUUsT0FBTyxDQUFDLENBQUMsS0FBSyxLQUFLLFFBQVEsQ0FBQyxDQUFDLENBQUMsQ0FBQyxDQUFDLEtBQUssQ0FBQyxDQUFDLENBQUMsSUFBSTtRQUNuRCxNQUFNLEVBQUUsQ0FBQyxDQUFDLE1BQU0sS0FBSyxJQUFJO1FBQ3pCLFFBQVEsRUFBRSxPQUFPLENBQUMsQ0FBQyxTQUFTLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxJQUFJO1FBQzlELFFBQVEsRUFBRSxPQUFPLENBQUMsQ0FBQyxTQUFTLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxDQUFDLENBQUMsU0FBUyxDQUFDLENBQUMsQ0FBQyxJQUFJO0tBQy9ELENBQUM7QUFDSixDQUFDO0FBRUQ7OztHQUdHO0FBQ0gsTUFBTSxVQUFVLFlBQVksQ0FBQyxNQUFzRTtJQUNqRyxNQUFNLENBQUMsR0FBRyxDQUFDLE1BQU0sSUFBSSxPQUFPLE1BQU0sS0FBSyxRQUFRLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsRUFBRSxDQUFnRCxDQUFDO0lBQzlHLE9BQU8sQ0FBQyxDQUFDLEtBQUssS0FBSyxRQUFRLElBQUksQ0FBQyxDQUFDLE1BQU0sS0FBSyxJQUFJLENBQUM7QUFDbkQsQ0FBQztBQUVEOzs7OztHQUtHO0FBQ0gsTUFBTSxVQUFVLHVCQUF1QixDQUFDLFNBQTBCLEVBQUU7SUFDbEUsTUFBTSxDQUFDLEdBQUcsQ0FBQyxNQUFNLElBQUksT0FBTyxNQUFNLEtBQUssUUFBUSxDQUFDLENBQUMsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBb0IsQ0FBQztJQUNsRixJQUFJLENBQUMsQ0FBQyxVQUFVLEtBQUssSUFBSTtRQUFFLE9BQU8sWUFBWSxDQUFDO0lBQy9DLElBQUksQ0FBQyxDQUFDLHFCQUFxQixLQUFLLElBQUk7UUFBRSxPQUFPLHlCQUF5QixDQUFDO0lBQ3ZFLE9BQU8sNEJBQTRCLENBQUM7QUFDdEMsQ0FBQztBQUVEOzs7Ozs7R0FNRztBQUNILE1BQU0sVUFBVSxnQkFBZ0IsQ0FDOUIsU0FBa0IsRUFDbEIsTUFBbUMsRUFDbkMsT0FBeUI7SUFFekIsTUFBTSxNQUFNLEdBQUcsc0JBQXNCLENBQUMsU0FBUyxDQUFDLENBQUM7SUFDakQsSUFBSSxDQUFDLFlBQVksQ0FBQyxNQUFNLENBQUM7UUFBRSxPQUFPLElBQUksQ0FBQztJQUN2QyxNQUFNLE1BQU0sR0FBRyx1QkFBdUIsQ0FBQyxNQUFNLENBQUMsQ0FBQztJQUMvQyxNQUFNLElBQUksR0FBRyxzQkFBc0IsQ0FBQyxNQUFNLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQyx3REFBd0Q7SUFDOUcsT0FBTyxFQUFFLE9BQU8sRUFBRSxrQkFBa0IsRUFBRSxNQUFNLEVBQUUsSUFBSSxFQUFFLE1BQU0sRUFBRSxDQUFDO0FBQy9ELENBQUMifQ==