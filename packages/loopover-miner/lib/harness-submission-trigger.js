import { evaluateHarnessSubmissionTrigger } from "@loopover/engine";
// Harness submission-gate wiring orchestrator (#2337): the real-IO half of connecting the gated-submission
// decision (`shouldSubmit`, wrapped by `evaluateHarnessSubmissionTrigger`, @loopover/engine) to a
// real driving loop's own handoff signal. Reads the session's recent decision history to compute the
// consecutive-block circuit-breaker tally, consults the pure decision, and always records exactly one audit
// event -- regardless of outcome, so a paused-pending-human-review session leaves a full trail of why.
//
// NOT WIRED INTO ANY AUTOMATIC SCHEDULE: per this issue's own "manual owner sign-off on the wiring before this
// ships to any default-on profile" deliverable. `prepareOpenPrSubmission` below is the gate→payload bridge:
// on `allow: true` it shapes the exact input `buildOpenPrSpec` (`@loopover/engine`,
// `packages/loopover-engine/src/miner/local-write-tools.ts`, re-exported from the engine public barrel) expects
// as `openPrInput`. It deliberately does NOT call `buildOpenPrSpec` itself -- that stays the caller's job so
// this module stays a decision-to-payload bridge. The in-package caller is `attempt-runner.js`, which imports
// `buildOpenPrSpec` from `@loopover/engine` and runs it after a `ready: true` result (the pre-#5131/#5132
// "unreachable from root `src/mcp/`" boundary no longer applies, but the layering still does: gate evaluate →
// shape openPrInput here → build the runnable local-write spec in the driver). Equivalent MCP call sites
// (e.g. `loopover_open_pr`) can likewise take `openPrInput` from a `ready: true` result.
//
// SESSION-SCOPED, NOT PER-REPO: the circuit breaker's own "pauses the run entirely" wording means the tally is
// counted across EVERY repo's decisions this session, not scoped to one repo -- distinct from #2338's loop-
// reentry circuit breaker, which is deliberately per-repo (a rejection streak on one repo must not pause
// unrelated repos).
export const HARNESS_SUBMISSION_TRIGGER_DECISION_EVENT = "harness_submission_trigger_decision";
/** Count consecutive `allow: false` decisions recorded at or after `sinceMs`, walking backward from the most
 *  recent decision until an `allow: true` breaks the streak (or history runs out). Session-scoped (not
 *  filtered by repo) to match the circuit breaker's own "pauses the run entirely" semantics. */
export function countConsecutiveGateBlocks(eventLedger, sinceMs) {
    const decisions = eventLedger
        .readEvents({})
        .filter((event) => event.type === HARNESS_SUBMISSION_TRIGGER_DECISION_EVENT && Date.parse(event.createdAt) >= sinceMs);
    let count = 0;
    for (let i = decisions.length - 1; i >= 0; i -= 1) {
        if (decisions[i].payload?.allow === true)
            break;
        count += 1;
    }
    return count;
}
/**
 * Evaluate the harness submission trigger for one candidate handoff, reading real session history to compute
 * the circuit-breaker tally, and always appending exactly one audit event. Fails closed (throws) on a
 * malformed candidate or missing required dependency.
 *
 * @param {{ killSwitchScope: "global"|"repo"|"none", repoFullName: string, handoffPacket: object, slopThreshold: "clean"|"low"|"elevated"|"high", mode: "observe"|"enforce", maxConsecutiveGateBlocks?: number }} candidate
 * @param {{ eventLedger: object, sessionStartMs?: number }} deps
 */
export function evaluateAndRecordHarnessSubmissionTrigger(candidate, deps) {
    if (!candidate || typeof candidate !== "object")
        throw new Error("invalid_harness_submission_candidate");
    if (!["global", "repo", "none"].includes(candidate.killSwitchScope))
        throw new Error("invalid_kill_switch_scope");
    const repoFullName = typeof candidate.repoFullName === "string" ? candidate.repoFullName.trim() : "";
    if (!repoFullName)
        throw new Error("invalid_repo_full_name");
    if (!candidate.handoffPacket || typeof candidate.handoffPacket !== "object")
        throw new Error("invalid_handoff_packet");
    if (!deps || typeof deps !== "object")
        throw new Error("invalid_harness_submission_deps");
    const { eventLedger, sessionStartMs = 0 } = deps;
    if (!eventLedger || typeof eventLedger.appendEvent !== "function" || typeof eventLedger.readEvents !== "function") {
        throw new Error("invalid_event_ledger");
    }
    const consecutiveGateBlocks = countConsecutiveGateBlocks(eventLedger, sessionStartMs);
    const decision = evaluateHarnessSubmissionTrigger({
        killSwitchScope: candidate.killSwitchScope,
        handoffPacket: candidate.handoffPacket,
        slopThreshold: candidate.slopThreshold,
        mode: candidate.mode,
        consecutiveGateBlocks,
        maxConsecutiveGateBlocks: candidate.maxConsecutiveGateBlocks,
    });
    const event = eventLedger.appendEvent({
        type: HARNESS_SUBMISSION_TRIGGER_DECISION_EVENT,
        repoFullName,
        payload: {
            killSwitchScope: candidate.killSwitchScope,
            allow: decision.allow,
            reasons: decision.reasons,
            circuitBreakerTripped: decision.circuitBreakerTripped,
            consecutiveGateBlocks,
            attemptLogReference: candidate.handoffPacket.attemptLogReference ?? null,
        },
    });
    return { decision, event };
}
/**
 * Bridge one completed handoff through the submission gate to a submission-READY payload -- the exact input
 * shape `buildOpenPrSpec` (`@loopover/engine`) expects (repoFullName/base/head/title/body/draft). On `allow:
 * true` returns `{ ready: true, decision, event, openPrInput }`; otherwise `{ ready: false, decision, event }`
 * -- the block reasons are on `decision.reasons` and already on the ledger via the wrapped call either way.
 * Does NOT call `buildOpenPrSpec` itself: this stays a gate→payload bridge; `attempt-runner.js` (and MCP
 * `loopover_open_pr` equivalents) take `openPrInput` from a `ready: true` result and call
 * `buildOpenPrSpec`. The cross-package "unreachable from root src/" reason no longer applies (#5131/#5132
 * moved the builder into `@loopover/engine`), but the deliberate non-call layering is still necessary.
 *
 * Fails closed (throws) on a malformed candidate, mirroring evaluateAndRecordHarnessSubmissionTrigger's own
 * validation -- a missing PR title/base is a caller bug that must never silently degrade into a garbage spec.
 * The one field evaluateAndRecordHarnessSubmissionTrigger does NOT itself require -- handoffPacket.branchRef,
 * optional there because iterate-loop.ts deliberately does not manage worktrees/branches -- IS required here,
 * but only once the decision is known to be `allow: true`: a PR cannot be opened without a source branch, but a
 * blocked candidate needs no branch at all, and must not throw for a reason unrelated to why it was blocked.
 *
 * @param {{ killSwitchScope: "global"|"repo"|"none", repoFullName: string, handoffPacket: { branchRef?: string, [key: string]: unknown }, slopThreshold: "clean"|"low"|"elevated"|"high", mode: "observe"|"enforce", maxConsecutiveGateBlocks?: number, base: string, title: string, body?: string, draft?: boolean }} candidate
 * @param {{ eventLedger: object, sessionStartMs?: number }} deps
 */
export function prepareOpenPrSubmission(candidate, deps) {
    if (!candidate || typeof candidate !== "object")
        throw new Error("invalid_harness_submission_candidate");
    const base = typeof candidate.base === "string" ? candidate.base.trim() : "";
    if (!base)
        throw new Error("invalid_pr_base");
    const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
    if (!title)
        throw new Error("invalid_pr_title");
    const { decision, event } = evaluateAndRecordHarnessSubmissionTrigger(candidate, deps);
    if (!decision.allow)
        return { ready: false, decision, event };
    // Only reached once evaluateAndRecordHarnessSubmissionTrigger has already validated handoffPacket is a
    // well-formed object -- safe to read .branchRef directly.
    const head = typeof candidate.handoffPacket.branchRef === "string" ? candidate.handoffPacket.branchRef.trim() : "";
    if (!head)
        throw new Error("invalid_pr_head_branch");
    return {
        ready: true,
        decision,
        event,
        openPrInput: {
            repoFullName: candidate.repoFullName.trim(),
            base,
            head,
            title,
            body: typeof candidate.body === "string" ? candidate.body : "",
            draft: candidate.draft === true,
        },
    };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaGFybmVzcy1zdWJtaXNzaW9uLXRyaWdnZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJoYXJuZXNzLXN1Ym1pc3Npb24tdHJpZ2dlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUsZ0NBQWdDLEVBQXNCLE1BQU0sa0JBQWtCLENBQUM7QUFFeEYsMkdBQTJHO0FBQzNHLGtHQUFrRztBQUNsRyxxR0FBcUc7QUFDckcsNEdBQTRHO0FBQzVHLHVHQUF1RztBQUN2RyxFQUFFO0FBQ0YsK0dBQStHO0FBQy9HLDRHQUE0RztBQUM1RyxvRkFBb0Y7QUFDcEYsZ0hBQWdIO0FBQ2hILDZHQUE2RztBQUM3Ryw4R0FBOEc7QUFDOUcsMEdBQTBHO0FBQzFHLDhHQUE4RztBQUM5Ryx5R0FBeUc7QUFDekcseUZBQXlGO0FBQ3pGLEVBQUU7QUFDRiwrR0FBK0c7QUFDL0csNEdBQTRHO0FBQzVHLHlHQUF5RztBQUN6RyxvQkFBb0I7QUFFcEIsTUFBTSxDQUFDLE1BQU0seUNBQXlDLEdBQUcscUNBQThDLENBQUM7QUEyQ3hHOztnR0FFZ0c7QUFDaEcsTUFBTSxVQUFVLDBCQUEwQixDQUFDLFdBQXlDLEVBQUUsT0FBZTtJQUNuRyxNQUFNLFNBQVMsR0FBRyxXQUFXO1NBQzFCLFVBQVUsQ0FBQyxFQUFFLENBQUM7U0FDZCxNQUFNLENBQUMsQ0FBQyxLQUFLLEVBQUUsRUFBRSxDQUFDLEtBQUssQ0FBQyxJQUFJLEtBQUsseUNBQXlDLElBQUksSUFBSSxDQUFDLEtBQUssQ0FBQyxLQUFLLENBQUMsU0FBUyxDQUFDLElBQUksT0FBTyxDQUFDLENBQUM7SUFDekgsSUFBSSxLQUFLLEdBQUcsQ0FBQyxDQUFDO0lBQ2QsS0FBSyxJQUFJLENBQUMsR0FBRyxTQUFTLENBQUMsTUFBTSxHQUFHLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQztRQUNsRCxJQUFJLFNBQVMsQ0FBQyxDQUFDLENBQUUsQ0FB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