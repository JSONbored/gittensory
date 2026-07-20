// Real PR-disposition poller (#5135, Wave 3.5 -- the autonomous loop). ci-poller.js already polls a PR's CI
// check-runs, but that answers a DIFFERENT question ("did the checks pass") from what the supervising loop
// needs at cycle-close time ("did the PR itself get merged or closed"). Nothing in this package answered that
// second question before this file: pr-outcome.js already has a real store for the classification
// (recordPrOutcomeSnapshot/readPrOutcomes), but every existing caller of it was a test -- this is the real
// GitHub fetch that produces the classification pr-outcome.js's writer expects.
//
// Deliberately its own module, not folded into ci-poller.js: the two pollers ask genuinely different
// questions (check-run conclusion vs. PR merge/close disposition) with different terminal conditions (a
// check-run poll's "pending" means "wait for the SAME head commit's checks to finish"; a disposition poll's
// "open" means "wait for a human to actually merge or close the PR", a potentially much longer, unbounded
// wait) -- composing them into one poller would conflate two different backoff/timeout policies.
import { fetchWithRetry } from "./http-retry.js";
const defaultApiBaseUrl = "https://api.github.com";
const defaultMinIntervalMs = 60_000;
const defaultMaxIntervalMs = 5 * 60_000;
const defaultMaxAttempts = 1;
const defaultRequestTimeoutMs = 10_000;
const githubApiVersion = "2022-11-28";
function normalizeApiBaseUrl(value) {
    if (value === undefined)
        return defaultApiBaseUrl;
    if (typeof value !== "string" || !value.trim())
        return defaultApiBaseUrl;
    let parsed;
    try {
        parsed = new URL(value.trim());
    }
    catch {
        throw new Error("invalid_api_base_url");
    }
    if (parsed.protocol !== "https:" || parsed.hostname !== "api.github.com") {
        throw new Error("invalid_api_base_url");
    }
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
}
function normalizePositiveInt(value, fallback, min, max) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.min(max, Math.max(min, Math.floor(value)));
}
function normalizeOptions(options = {}) {
    return {
        apiBaseUrl: normalizeApiBaseUrl(options.apiBaseUrl),
        fetchFn: options.fetchFn ?? fetch,
        githubToken: typeof options.githubToken === "string" ? options.githubToken.trim() : "",
        maxAttempts: normalizePositiveInt(options.maxAttempts, defaultMaxAttempts, 1, 20),
        minIntervalMs: normalizePositiveInt(options.minIntervalMs, defaultMinIntervalMs, 1, 60 * 60_000),
        maxIntervalMs: normalizePositiveInt(options.maxIntervalMs, defaultMaxIntervalMs, 1, 60 * 60_000),
        requestTimeoutMs: normalizePositiveInt(options.requestTimeoutMs, defaultRequestTimeoutMs, 1, 60_000),
        sleepFn: options.sleepFn ??
            ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs))),
    };
}
function parseRepoFullName(repoFullName) {
    if (typeof repoFullName !== "string")
        throw new Error("invalid_repo_full_name");
    const [owner, repo, extra] = repoFullName.split("/");
    if (!owner?.trim() || !repo?.trim() || extra !== undefined) {
        throw new Error("invalid_repo_full_name");
    }
    return { owner: owner.trim(), repo: repo.trim() };
}
function normalizePullNumber(value) {
    if (!Number.isInteger(value) || value <= 0)
        throw new Error("invalid_pr_number");
    return value;
}
function githubHeaders(githubToken) {
    const headers = {
        accept: "application/vnd.github+json",
        "user-agent": "loopover-miner",
        "x-github-api-version": githubApiVersion,
    };
    if (githubToken)
        headers.authorization = `Bearer ${githubToken}`;
    return headers;
}
function repoPath(target, suffix) {
    return `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}${suffix}`;
}
function apiUrl(apiBaseUrl, path) {
    return `${apiBaseUrl}${path}`;
}
function githubError(response, payload) {
    const code = `github_${response.status}`;
    const githubMessage = typeof payload?.message === "string" && payload.message.trim() ? payload.message : null;
    const message = githubMessage ? `${code}: ${githubMessage}` : code;
    return Object.assign(new Error(message), { code, githubMessage });
}
async function fetchPullRequest(target, prNumber, options) {
    // Retry transient network errors / 5xx around this single call (#4829), matching ci-poller.js's
    // githubGetJsonResponse -- distinct from this poller's OWN outer pending-retry loop. requestTimeoutMs bounds
    // each individual attempt with a fresh AbortSignal.timeout() (a stalled connection can't hang a poll cycle
    // forever -- #miner-github-read-timeouts); the injected sleepFn keeps the retry backoff instant in tests.
    const response = await fetchWithRetry(options.fetchFn, apiUrl(options.apiBaseUrl, repoPath(target, `/pulls/${prNumber}`)), { method: "GET", headers: githubHeaders(options.githubToken) }, { sleepFn: options.sleepFn, timeoutMs: options.requestTimeoutMs });
    const payload = (await response.json().catch(() => null));
    if (!response.ok)
        throw githubError(response, payload);
    return payload;
}
/** GitHub's own vocabulary is `state: "open"|"closed"` plus a separate `merged: boolean` -- "closed and not
 *  merged" is the disengaged case. A still-open PR is never terminal for this poller's purposes. */
function normalizeDisposition(payload) {
    const state = payload?.state === "closed" ? "closed" : "open";
    const merged = Boolean(payload?.merged);
    const closedAt = typeof payload?.closed_at === "string" ? payload.closed_at : null;
    return { state, merged, closedAt };
}
function backoffDelayMs(attemptIndex, options) {
    const exponent = Math.min(10, Math.max(0, attemptIndex));
    return Math.min(options.maxIntervalMs, options.minIntervalMs * 2 ** exponent);
}
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
export async function pollPrDisposition(repoFullName, prNumber, options = {}) {
    const target = parseRepoFullName(repoFullName);
    const normalizedPrNumber = normalizePullNumber(prNumber);
    const normalizedOptions = normalizeOptions(options);
    let latest = { state: "open", merged: false, closedAt: null, attempts: 0 };
    for (let attempt = 0; attempt < normalizedOptions.maxAttempts; attempt += 1) {
        const payload = await fetchPullRequest(target, normalizedPrNumber, normalizedOptions);
        latest = { ...normalizeDisposition(payload), attempts: attempt + 1 };
        if (latest.state === "closed")
            return latest;
        if (attempt === normalizedOptions.maxAttempts - 1)
            return latest;
        await normalizedOptions.sleepFn(backoffDelayMs(attempt, normalizedOptions));
    }
    // Unreachable at runtime: maxAttempts is normalized to >= 1, so the loop always returns on its final iteration
    // (the `attempt === maxAttempts - 1` guard). Kept only to satisfy the compiler's all-paths-return requirement.
    /* v8 ignore next -- unreachable: the normalized maxAttempts >= 1 loop always returns before falling through */
    return latest;
}
/**
 * Classify a real, terminal PR disposition into loop-reentry.js's own `candidate.outcome` vocabulary
 * (`"merged"|"disengaged"|"other"`). A still-open disposition (not yet resolved) classifies as `"other"` --
 * the same bucket a runMinerAttempt outcome that never opened a PR at all falls into (nothing to re-enter on
 * yet, in either case).
 *
 * @param {{ state: "open"|"closed", merged: boolean }} disposition
 * @returns {"merged"|"disengaged"|"other"}
 */
export function classifyPrDisposition(disposition) {
    if (disposition.state !== "closed")
        return "other";
    return disposition.merged ? "merged" : "disengaged";
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHItZGlzcG9zaXRpb24tcG9sbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicHItZGlzcG9zaXRpb24tcG9sbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLDRHQUE0RztBQUM1RywyR0FBMkc7QUFDM0csOEdBQThHO0FBQzlHLGtHQUFrRztBQUNsRywyR0FBMkc7QUFDM0csZ0ZBQWdGO0FBQ2hGLEVBQUU7QUFDRixxR0FBcUc7QUFDckcsd0dBQXdHO0FBQ3hHLDRHQUE0RztBQUM1RywwR0FBMEc7QUFDMUcsaUdBQWlHO0FBRWpHLE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQTBDakQsTUFBTSxpQkFBaUIsR0FBRyx3QkFBd0IsQ0FBQztBQUNuRCxNQUFNLG9CQUFvQixHQUFHLE1BQU0sQ0FBQztBQUNwQyxNQUFNLG9CQUFvQixHQUFHLENBQUMsR0FBRyxNQUFNLENBQUM7QUFDeEMsTUFBTSxrQkFBa0IsR0FBRyxDQUFDLENBQUM7QUFDN0IsTUFBTSx1QkFBdUIsR0FBRyxNQUFNLENBQUM7QUFDdkMsTUFBTSxnQkFBZ0IsR0FBRyxZQUFZLENBQUM7QUFFdEMsU0FBUyxtQkFBbUIsQ0FBQyxLQUFjO0lBQ3pDLElBQUksS0FBSyxLQUFLLFNBQVM7UUFBRSxPQUFPLGlCQUFpQixDQUFDO0lBQ2xELElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRTtRQUFFLE9BQU8saUJBQWlCLENBQUM7SUFDekUsSUFBSSxNQUFNLENBQUM7SUFDWCxJQUFJLENBQUM7UUFDSCxNQUFNLEdBQUcsSUFBSSxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxDQUFDLENBQUM7SUFDakMsQ0FBQztJQUFDLE1BQU0sQ0FBQztRQUNQLE1BQU0sSUFBSSxLQUFLLENBQUMsc0JBQXNCLENBQUMsQ0FBQztJQUMxQyxDQUFDO0lBQ0QsSUFBSSxNQUFNLENBQUMsUUFBUSxLQUFLLFFBQVEs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