export type PrDisposition = {
    state: "open" | "closed";
    merged: boolean;
    closedAt: string | null;
    attempts: number;
};
export type PollPrDispositionOptions = {
    apiBaseUrl?: string;
    fetchFn?: typeof fetch;
    githubToken?: string;
    maxAttempts?: number;
    minIntervalMs?: number;
    maxIntervalMs?: number;
    requestTimeoutMs?: number;
    sleepFn?: (delayMs: number) => Promise<void>;
};
/**
 * Poll a real PR's own merge/close disposition (distinct from its CI check-run conclusion, ci-poller.js's
 * concern) with exponential backoff, until it reaches a terminal `state: "closed"` or `maxAttempts` is
 * exhausted -- whichever comes first. A still-`"open"` PR after the last attempt is returned as-is, not an
 * error: an unattended loop cycle should treat "still open" as "not yet resolved", not fail.
 *
 * @param {string} repoFullName
 * @param {number} prNumber
 * @param {{
 *   apiBaseUrl?: string, fetchFn?: typeof fetch, githubToken?: string, maxAttempts?: number,
 *   minIntervalMs?: number, maxIntervalMs?: number, sleepFn?: (delayMs: number) => Promise<void>,
 * }} [options]
 * @returns {Promise<{ state: "open"|"closed", merged: boolean, closedAt: string|null, attempts: number }>}
 */
export declare function pollPrDisposition(repoFullName: string, prNumber: number, options?: PollPrDispositionOptions): Promise<PrDisposition>;
/**
 * Classify a real, terminal PR disposition into loop-reentry.js's own `candidate.outcome` vocabulary
 * (`"merged"|"disengaged"|"other"`). A still-open disposition (not yet resolved) classifies as `"other"` --
 * the same bucket a runMinerAttempt outcome that never opened a PR at all falls into (nothing to re-enter on
 * yet, in either case).
 *
 * @param {{ state: "open"|"closed", merged: boolean }} disposition
 * @returns {"merged"|"disengaged"|"other"}
 */
export declare function classifyPrDisposition(disposition: Pick<PrDisposition, "state" | "merged">): "merged" | "disengaged" | "other";
