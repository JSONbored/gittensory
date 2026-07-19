// The Governor chokepoint gate (#2340). Wraps the pure `evaluateGovernorChokepoint` engine decision with the
// two stateful side effects every caller needs: persisting the resulting ledger event, and (only when the
// rate-limit stage actually ran) advancing/backing-off the rate-limit bucket state. This is the ONLY sanctioned
// call site a real write action (open_pr, file_issue, apply_labels, post_eligibility_comment, create_branch,
// delete_branch, generate_tests) should be gated through.
import { clearWriteRateLimitBackoff, evaluateGovernorChokepoint, recordWriteRateLimitAllowed, recordWriteRateLimitDenied, } from "@loopover/engine";
import { appendGovernorEvent } from "./governor-ledger.js";
/**
 * Evaluate a write action against the full Governor precedence ladder, persist the resulting ledger event, and
 * advance rate-limit bucket/backoff state only for the two outcomes that actually consumed (or were denied at)
 * the rate-limit stage: a final `"allow"` verdict advances the bucket, and a `"rate_limit"`-stage denial bumps
 * backoff. Every other stage -- kill-switch, dry-run, budget-cap, non-convergence, reputation-throttle,
 * self-plagiarism, internal_error -- denies for a reason unrelated to rate limiting and must leave bucket/backoff
 * state untouched, since no real write happened and the rate-limit stage's own "allowed" sub-verdict (still
 * present in `decision.detail.rateLimit` once that stage has cleared) does not mean the action was ultimately
 * allowed.
 */
export function evaluateGovernorChokepointGate(input, options = {}) {
    const append = options.append ?? appendGovernorEvent;
    const decision = evaluateGovernorChokepoint(input);
    // Same wider-declared-than-actual mismatch as governor-kill-switch.ts's cast: the engine's ledgerEvent type
    // allows an explicit `undefined` value on optional fields (never actually produced), which this module's
    // narrower AppendGovernorEventInput rejects under `exactOptionalPropertyTypes`.
    const recorded = append(decision.ledgerEvent);
    let rateLimitBuckets = input.rateLimitBuckets;
    let rateLimitBackoffAttempts = input.rateLimitBackoffAttempts;
    if (decision.stage === "allow") {
        rateLimitBuckets = recordWriteRateLimitAllowed(input.rateLimitBuckets, input.actionClass, input.repoFullName, input.nowMs, input.rateLimitPolicies);
        rateLimitBackoffAttempts = clearWriteRateLimitBackoff(input.rateLimitBackoffAttempts, input.actionClass, input.repoFullName);
    }
    else if (decision.stage === "rate_limit") {
        rateLimitBackoffAttempts = recordWriteRateLimitDenied(input.rateLimitBackoffAttempts, input.actionClass, input.repoFullName);
    }
    return { decision, recorded, rateLimitBuckets, rateLimitBackoffAttempts };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ292ZXJub3ItY2hva2Vwb2ludC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImdvdmVybm9yLWNob2tlcG9pbnQudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsNkdBQTZHO0FBQzdHLDBHQUEwRztBQUMxRyxnSEFBZ0g7QUFDaEgsNkdBQTZHO0FBQzdHLDBEQUEwRDtBQUUxRCxPQUFPLEVBQ0wsMEJBQTBCLEVBQzFCLDBCQUEwQixFQUMxQiwyQkFBMkIsRUFDM0IsMEJBQTBCLEdBSzNCLE1BQU0sa0JBQWtCLENBQUM7QUFDMUIsT0FBTyxFQUFFLG1CQUFtQixFQUEyRCxNQUFNLHNCQUFzQixDQUFDO0FBU3BIOzs7Ozs7Ozs7R0FTRztBQUNILE1BQU0sVUFBVSw4QkFBOEIsQ0FDNUMsS0FBOEIsRUFDOUIsVUFBaUYsRUFBRTtJQUVuRixNQUFNLE1BQU0sR0FBRyxPQUFPLENBQUMsTUFBTSxJQUFJLG1CQUFtQixDQUFDO0lBQ3JELE1BQU0sUUFBUSxHQUFHLDBCQUEwQixDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ25ELDRHQUE0RztJQUM1Ryx5R0FBeUc7SUFDekcsZ0ZBQWdGO0lBQ2hGLE1BQU0sUUFBUSxHQUFHLE1BQU0sQ0FBQyxRQUFRLENBQUMsV0FBdUMsQ0FBQyxDQUFDO0lBRTFFLElBQUksZ0JBQWdCLEdBQUcsS0FBSyxDQUFDLGdCQUFnQixDQUFDO0lBQzlDLElBQUksd0JBQXdCLEdBQUcsS0FBSyxDQUFDLHdCQUF3QixDQUFDO0lBQzlELElBQUksUUFBUSxDQUFDLEtBQUssS0FBSyxPQUFPLEVBQUUsQ0FBQztRQUMvQixnQkFBZ0IsR0FBRywyQkFBMkIsQ0FDNUMsS0FBSyxDQUFDLGdCQUFnQixFQUN0QixLQUFLLENBQUMsV0FBVyxFQUNqQixLQUFLLENBQUMsWUFBWSxFQUNsQixLQUFLLENBQUMsS0FBSyxFQUNYLEtBQUssQ0FBQyxpQkFBaUIsQ0FDeEIsQ0FBQztRQUNGLHdCQUF3QixHQUFHLDBCQUEwQixDQUFDLEtBQUssQ0FBQyx3QkFBd0IsRUFBRSxLQUFLLENBQUMsV0FBVyxFQUFFLEtBQUssQ0FBQyxZQUFZLENBQUMsQ0FBQztJQUMvSCxDQUFDO1NBQU0sSUFBSSxRQUFRLENBQUMsS0FBSyxLQUFLLFlBQVksRUFBRSxDQUFDO1FBQzNDLHdCQUF3QixHQUFHLDBCQUEwQixDQUFDLEtBQUssQ0FBQyx3QkFBd0IsRUFBRSxLQUFLLENBQUMsV0FBVyxFQUFFLEtBQUssQ0FBQyxZQUFZLENBQUMsQ0FBQztJQUMvSCxDQUFDO0lBRUQsT0FBTyxFQUFFLFFBQVEsRUFBRSxRQUFRLEVBQUUsZ0JBQWdCLEVBQUUsd0JBQXdCLEVBQUUsQ0FBQztBQUM1RSxDQUFDIn0=