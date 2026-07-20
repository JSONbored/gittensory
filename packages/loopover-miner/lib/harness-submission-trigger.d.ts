export declare const HARNESS_SUBMISSION_TRIGGER_DECISION_EVENT: "harness_submission_trigger_decision";
export type HarnessSubmissionSlopBand = "clean" | "low" | "elevated" | "high";
export type HarnessSubmissionMode = "observe" | "enforce";
export type HarnessSubmissionKillSwitchScope = "global" | "repo" | "none";
export type HarnessSubmissionCandidateInput = {
    /** Forwarded to shouldSubmit's own kill-switch check (#2339). */
    killSwitchScope: HarnessSubmissionKillSwitchScope;
    repoFullName: string;
    handoffPacket: {
        worktreePath: string;
        branchRef?: string;
        diffSummary: string;
        selfReviewVerdict: unknown;
        attemptLogReference: string;
    };
    slopThreshold: HarnessSubmissionSlopBand;
    mode: HarnessSubmissionMode;
    maxConsecutiveGateBlocks?: number;
};
export interface HarnessSubmissionEventLedger {
    appendEvent(event: {
        type: string;
        repoFullName?: string;
        payload: Record<string, unknown>;
    }): {
        id: number;
        seq: number;
        type: string;
        repoFullName: string | null;
        payload: Record<string, unknown>;
        createdAt: string;
    };
    readEvents(filter?: {
        since?: number;
        repoFullName?: string;
    }): Array<{
        type: string;
        repoFullName?: string | null;
        payload?: Record<string, unknown>;
        createdAt: string;
    }>;
}
export type HarnessSubmissionDeps = {
    eventLedger: HarnessSubmissionEventLedger;
    sessionStartMs?: number;
};
export type HarnessSubmissionDecision = {
    allow: boolean;
    reasons: string[];
    circuitBreakerTripped: boolean;
};
export type HarnessSubmissionResult = {
    decision: HarnessSubmissionDecision;
    event: {
        id: number;
        seq: number;
        type: string;
        repoFullName: string | null;
        payload: Record<string, unknown>;
        createdAt: string;
    };
};
/** Count consecutive `allow: false` decisions recorded at or after `sinceMs`, walking backward from the most
 *  recent decision until an `allow: true` breaks the streak (or history runs out). Session-scoped (not
 *  filtered by repo) to match the circuit breaker's own "pauses the run entirely" semantics. */
export declare function countConsecutiveGateBlocks(eventLedger: HarnessSubmissionEventLedger, sinceMs: number): number;
/**
 * Evaluate the harness submission trigger for one candidate handoff, reading real session history to compute
 * the circuit-breaker tally, and always appending exactly one audit event. Fails closed (throws) on a
 * malformed candidate or missing required dependency.
 *
 * @param {{ killSwitchScope: "global"|"repo"|"none", repoFullName: string, handoffPacket: object, slopThreshold: "clean"|"low"|"elevated"|"high", mode: "observe"|"enforce", maxConsecutiveGateBlocks?: number }} candidate
 * @param {{ eventLedger: object, sessionStartMs?: number }} deps
 */
export declare function evaluateAndRecordHarnessSubmissionTrigger(candidate: HarnessSubmissionCandidateInput, deps: HarnessSubmissionDeps): HarnessSubmissionResult;
/** The exact input shape buildOpenPrSpec (`@loopover/engine`) expects. */
export type OpenPrInput = {
    repoFullName: string;
    base: string;
    head: string;
    title: string;
    body: string;
    draft: boolean;
};
export type PrepareOpenPrSubmissionCandidate = HarnessSubmissionCandidateInput & {
    base: string;
    title: string;
    body?: string;
    draft?: boolean;
};
export type PrepareOpenPrSubmissionResult = {
    ready: true;
    decision: HarnessSubmissionDecision;
    event: HarnessSubmissionResult["event"];
    openPrInput: OpenPrInput;
} | {
    ready: false;
    decision: HarnessSubmissionDecision;
    event: HarnessSubmissionResult["event"];
};
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
export declare function prepareOpenPrSubmission(candidate: PrepareOpenPrSubmissionCandidate, deps: HarnessSubmissionDeps): PrepareOpenPrSubmissionResult;
