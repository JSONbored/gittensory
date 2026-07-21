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
import { buildAmsPrOutcomePayload, scheduleAmsNotificationEvents, } from "./ams-notifications.js";
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
    if (!Number.isInteger(record.prNumber) || record.prNumber <= 0)
        return null;
    const decision = optionalString(record.decision);
    if (!decision || !decisionSet.has(decision))
        return null;
    const reasonRaw = optionalString(record.reason);
    const reason = decision === "closed" && reasonRaw !== null && reasonSet.has(reasonRaw) ? reasonRaw : null;
    return {
        prNumber: record.prNumber,
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
    const repoFullName = typeof input.repoFullName === "string" ? input.repoFullName.trim() : "";
    if (!repoFullName)
        return null;
    const payload = normalizePrOutcomePayload({
        prNumber: input.prNumber,
        decision: input.decision,
        closedAt: input.closedAt,
        reason: input.reason,
    });
    if (!payload)
        return null;
    const entry = eventLedger.appendEvent({ type: MINER_PR_OUTCOME_EVENT, repoFullName, payload });
    // AMS badge notify (#7657): fire-and-forget when a recipient login is known (loop-cli passes minerLogin).
    const recipientLogin = typeof options.recipientLogin === "string" ? options.recipientLogin.trim() : "";
    if (recipientLogin) {
        const schedule = options.scheduleAmsNotifications ?? scheduleAmsNotificationEvents;
        schedule([
            buildAmsPrOutcomePayload({
                recipientLogin,
                repoFullName,
                pullNumber: payload.prNumber,
                decision: payload.decision,
                closedAt: payload.closedAt,
            }),
        ], { env: options.env ?? process.env });
    }
    return entry;
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
    for (const event of Array.isArray(events) ? events : []) {
        if (!event || typeof event !== "object")
            continue;
        const row = event;
        if (row.type !== MINER_PR_OUTCOME_EVENT)
            continue;
        if (typeof row.repoFullName !== "string" || !row.repoFullName.trim())
            continue;
        const normalized = normalizePrOutcomePayload(row.payload);
        if (!normalized)
            continue;
        // Re-key on every event so Map iteration order tracks most-recently-UPDATED last, not first-seen (#7222). A
        // bare Map.set() on an existing key updates the value but leaves the key frozen at its original position, so a
        // later outcome for the same PR (e.g. closed-without-merge, then reopened + merged) stayed at its old slot --
        // breaking recency-ordered consumers like loop-reentry.js's countConsecutiveDisengagements. Deleting first
        // moves the freshly-updated entry to the end, matching this reducer's own "a later event supersedes" contract.
        const key = `${row.repoFullName}:${normalized.prNumber}`;
        latest.delete(key);
        latest.set(key, { ...normalized, repoFullName: row.repoFullName });
    }
    return latest;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHItb3V0Y29tZS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInByLW91dGNvbWUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsaUhBQWlIO0FBQ2pILDBHQUEwRztBQUMxRyxpSEFBaUg7QUFDakgsOEJBQThCO0FBQzlCLEVBQUU7QUFDRiw2R0FBNkc7QUFDN0csK0dBQStHO0FBQy9HLDhHQUE4RztBQUM5RyxrSEFBa0g7QUFDbEgsMkZBQTJGO0FBRTNGLE9BQU8sRUFBRSxpQkFBaUIsRUFBRSxNQUFNLDBCQUEwQixDQUFDO0FBRTdELE9BQU8sRUFDTCx3QkFBd0IsRUFDeEIsNkJBQTZCLEdBRTlCLE1BQU0sd0JBQXdCLENBQUM7QUFFaEMsNERBQTREO0FBQzVELE1BQU0sQ0FBQyxNQUFNLHNCQUFzQixHQUFHLFlBQXFCLENBQUM7QUFFNUQscUVBQXFFO0FBQ3JFLE1BQU0sQ0FBQyxNQUFNLDBCQUEwQixHQUFHLE1BQU0sQ0FBQyxNQUFNLENBQUMsQ0FBQyxRQUFRLEVBQUUsUUFBUSxDQUFVLENBQUMsQ0FBQztBQXFDdkYsTUFBTSxXQUFXLEdBQUcsSUFBSSxHQUFHLENBQVMsMEJBQTBCLENBQUMsQ0FBQztBQUNoRSxNQUFNLFNBQVMsR0FBRyxJQUFJLEdBQUcsQ0FBUyxpQkFBaUIsQ0FBQyxDQUFDO0FBRXJELFNBQVMsY0FBYyxDQUFDLEtBQWM7SUFDcEMsSUFBSSxLQUFLLEtBQUssU0FBUyxJQUFJLEtBQUssS0FBSyxJQUFJO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDdkQsSUFBSSxPQUFPLEtBQUssS0FBSyxRQUFRO1FBQUUsT0FBTyxJQUFJLENBQUM7SUFDM0MsTUFBTSxPQUFPLEdBQUcsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDO0lBQzdCLE9BQU8sT0FBTyxJQUFJLElBQUksQ0FBQztBQUN6QixDQUFDO0FBRUQ7Ozs7O0dBS0c7QUFDSCxNQUFNLFVBQVUseUJBQXlCLENBQUMsT0FBZ0I7SUFDeEQsSUFBSSxDQUFDLE9BQU8sSUFB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