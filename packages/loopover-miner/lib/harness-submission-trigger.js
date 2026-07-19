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
        if (decisions[i]?.payload?.allow === true)
            break;
        count += 1;
    }
    return count;
}
/**
 * Evaluate the harness submission trigger for one candidate handoff, reading real session history to compute
 * the circuit-breaker tally, and always appending exactly one audit event. Fails closed (throws) on a
 * malformed candidate or missing required dependency.
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaGFybmVzcy1zdWJtaXNzaW9uLXRyaWdnZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJoYXJuZXNzLXN1Ym1pc3Npb24tdHJpZ2dlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQSxPQUFPLEVBQUUsZ0NBQWdDLEVBQUUsTUFBTSxrQkFBa0IsQ0FBQztBQUdwRSwyR0FBMkc7QUFDM0csa0dBQWtHO0FBQ2xHLHFHQUFxRztBQUNyRyw0R0FBNEc7QUFDNUcsdUdBQXVHO0FBQ3ZHLEVBQUU7QUFDRiwrR0FBK0c7QUFDL0csNEdBQTRHO0FBQzVHLG9GQUFvRjtBQUNwRixnSEFBZ0g7QUFDaEgsNkdBQTZHO0FBQzdHLDhHQUE4RztBQUM5RywwR0FBMEc7QUFDMUcsOEdBQThHO0FBQzlHLHlHQUF5RztBQUN6Ryx5RkFBeUY7QUFDekYsRUFBRTtBQUNGLCtHQUErRztBQUMvRyw0R0FBNEc7QUFDNUcseUdBQXlHO0FBQ3pHLG9CQUFvQjtBQUVwQixNQUFNLENBQUMsTUFBTSx5Q0FBeUMsR0FBRyxxQ0FBcUMsQ0FBQztBQTJDL0Y7O2dHQUVnRztBQUNoRyxNQUFNLFVBQVUsMEJBQTBCLENBQUMsV0FBeUMsRUFBRSxPQUFlO0lBQ25HLE1BQU0sU0FBUyxHQUFHLFdBQVc7U0FDMUIsVUFBVSxDQUFDLEVBQUUsQ0FBQztTQUNkLE1BQU0sQ0FBQyxDQUFDLEtBQUssRUFBRSxFQUFFLENBQUMsS0FBSyxDQUFDLElBQUksS0FBSyx5Q0FBeUMsSUFBSSxJQUFJLENBQUMsS0FBSyxDQUFDLEtBQUssQ0FBQyxTQUFTLENBQUMsSUFBSSxPQUFPLENBQUMsQ0FBQztJQUN6SCxJQUFJLEtBQUssR0FBRyxDQUFDLENBQUM7SUFDZCxLQUFLLElBQUksQ0FBQyxHQUFHLFNBQVMsQ0FBQyxNQUFNLEdBQUcsQ0FBQyxFQUFFLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDO1FBQ2xELElBQUksU0FBUyxDQUFDLENBQUMsQ0FBQyxFQUFF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