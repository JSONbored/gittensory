// Miner-local PR-outcome record (#4274). The miner's OWN local record of the outcomes of its OWN PRs — merged or
// closed — written to the miner's local SQLite via the generic append-only event-ledger.js, mirroring how
// manage-status.js layers a specific typed event (MANAGE_PR_UPDATE_EVENT + a payload normalizer + a thin writer)
// on top of that same ledger.
//
// DISTINCT from the server-side `pr_outcome` concept: src/review/outcomes-wire.ts's `recordPrOutcome` writes
// `pr_outcome` rows to the HOSTED backend's D1 audit tables from the GitHub App's webhook stream — that is the
// loopover SERVER recording ground truth for every contributor. THIS is a laptop-mode miner's local record of
// its own PRs (it may have no webhook relay at all): same concept name, different codebase layer, no shared code.
// The distinct `MINER_PR_OUTCOME_EVENT` local constant keeps the two from being conflated.
import { REJECTION_REASONS } from "./rejection-templates.js";
/** Event-ledger vocabulary for a miner-local PR outcome. */
export const MINER_PR_OUTCOME_EVENT = "pr_outcome";
/** The terminal decisions a miner records for one of its own PRs. */
export const MINER_PR_OUTCOME_DECISIONS = Object.freeze(["merged", "closed"]);
const decisionSet = new Set(MINER_PR_OUTCOME_DECISIONS);
const reasonSet = new Set(REJECTION_REASONS);
function optionalString(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return trimmed || null;
}
/**
 * Validate + normalize a PR-outcome payload; returns `null` on any malformed shape (mirrors manage-status.js's
 * `normalizeManageUpdatePayload`, so a bad row can neither be written nor read back). A `closed` decision may carry
 * a reason bucket drawn from {@link REJECTION_REASONS} (shared with the rejection-state-machine sibling); a `merged`
 * decision — or an unrecognized reason — normalizes the reason to `null` (a merged PR has no rejection reason).
 */
export function normalizePrOutcomePayload(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
        return null;
    const record = payload;
    const prNumber = record.prNumber;
    if (typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber <= 0)
        return null;
    const decision = optionalString(record.decision);
    if (!decision || !decisionSet.has(decision))
        return null;
    const reasonRaw = optionalString(record.reason);
    const reason = decision === "closed" && reasonRaw !== null && reasonSet.has(reasonRaw) ? reasonRaw : null;
    return {
        prNumber,
        decision: decision,
        closedAt: optionalString(record.closedAt),
        reason,
    };
}
/**
 * Thin writer over an INJECTED event ledger (same dependency-injection shape as manage-poll.js's
 * `recordManagePollSnapshot`, so it's unit-testable without a real ledger file). Appends one
 * {@link MINER_PR_OUTCOME_EVENT} scoped to the repo and returns the appended entry. Fail-soft on a malformed
 * snapshot: a missing repo or an invalid payload returns `null` rather than throwing (an unusable ledger is the
 * only hard error, since that is a programmer wiring mistake).
 */
export function recordPrOutcomeSnapshot(input, options = {}) {
    const eventLedger = options.eventLedger;
    if (!eventLedger || typeof eventLedger.appendEvent !== "function")
        throw new Error("invalid_event_ledger");
    const repoFullName = typeof input?.repoFullName === "string" ? input.repoFullName.trim() : "";
    if (!repoFullName)
        return null;
    const payload = normalizePrOutcomePayload({
        prNumber: input?.prNumber,
        decision: input?.decision,
        closedAt: input?.closedAt,
        reason: input?.reason,
    });
    if (!payload)
        return null;
    return eventLedger.appendEvent({ type: MINER_PR_OUTCOME_EVENT, repoFullName, payload: payload });
}
/**
 * Reconstruct the latest outcome per repo/PR from the ledger's ascending append-only event stream (mirrors
 * manage-status.js's `indexLatestManageUpdates`). Reads via the injected ledger's `readEvents(filter)` and reduces
 * the pure result — a later event for the same repo/PR supersedes an earlier one. Returns a `Map` keyed by
 * `repoFullName:prNumber`.
 */
export function readPrOutcomes(eventLedger, filter = {}) {
    const events = eventLedger && typeof eventLedger.readEvents === "function" ? eventLedger.readEvents(filter) : [];
    const latest = new Map();
    for (const rawEvent of Array.isArray(events) ? events : []) {
        const event = rawEvent;
        if (event?.type !== MINER_PR_OUTCOME_EVENT)
            continue;
        if (typeof event.repoFullName !== "string" || !event.repoFullName.trim())
            continue;
        const normalized = normalizePrOutcomePayload(event.payload);
        if (!normalized)
            continue;
        // Re-key on every event so Map iteration order tracks most-recently-UPDATED last, not first-seen (#7222). A
        // bare Map.set() on an existing key updates the value but leaves the key frozen at its original position, so a
        // later outcome for the same PR (e.g. closed-without-merge, then reopened + merged) stayed at its old slot --
        // breaking recency-ordered consumers like loop-reentry.js's countConsecutiveDisengagements. Deleting first
        // moves the freshly-updated entry to the end, matching this reducer's own "a later event supersedes" contract.
        const key = `${event.repoFullName}:${normalized.prNumber}`;
        latest.delete(key);
        latest.set(key, { ...normalized, repoFullName: event.repoFullName });
    }
    return latest;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHItb3V0Y29tZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInByLW91dGNvbWUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsaUhBQWlIO0FBQ2pILDBHQUEwRztBQUMxRyxpSEFBaUg7QUFDakgsOEJBQThCO0FBQzlCLEVBQUU7QUFDRiw2R0FBNkc7QUFDN0csK0dBQStHO0FBQy9HLDhHQUE4RztBQUM5RyxrSEFBa0g7QUFDbEgsMkZBQTJGO0FBRzNGLE9BQU8sRUFBRSxpQkFBaUIsRUFBRSxNQUFNLDBCQUEwQixDQUFDO0FBOEI3RCw0REFBNEQ7QUFDNUQsTUFBTSxDQUFDLE1BQU0sc0JBQXNCLEdBQUcsWUFBWSxDQUFDO0FBRW5ELHFFQUFxRTtBQUNyRSxNQUFNLENBQUMsTUFBTSwwQkFBMEIsR0FBRyxNQUFNLENBQUMsTUFBTSxDQUFDLENBQUMsUUFBUSxFQUFFLFFBQVEsQ0FBVSxDQUFDLENBQUM7QUFFdkYsTUFBTSxXQUFXLEdBQUcsSUFBSSxHQUFHLENBQVMsMEJBQTBCLENBQUMsQ0FBQztBQUNoRSxNQUFNLFNBQVMsR0FBRyxJQUFJLEdBQUcsQ0FBUyxpQkFBaUIsQ0FBQyxDQUFDO0FBRXJELFNBQVMsY0FBYyxDQUFDLEtBQWM7SUFDcEMsSUFBSSxLQUFLLEtBQUssU0FBUyxJQUFJLEtBQUssS0FBSyxJQUFJO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDdkQsSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDM0MsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO0lBQzdCLE9BQU8sT0FBTyxJQUFJLElBQUksQ0FBQztBQUN6QixDQUFDO0FBRUQ7Ozs7O0dBS0c7QUFDSCxNQUFNLFVBQVUseUJBQXlCLENBQUMsT0FBZ0I7SUFDeEQsSUFBSSxDQUFDLE9BQU8sSUFBSSxPQUFPLE9BQU8sS0FBSyxRQUFRLElBQUksS0FBSyxDQUFDLE9BQU8sQ0FBQyxPQUFPLENBQUM7UUFB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