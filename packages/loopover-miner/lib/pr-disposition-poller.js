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
    const payloadMessage = payload?.message;
    const githubMessage = typeof payloadMessage === "string" && payloadMessage.trim() ? payloadMessage : null;
    const message = githubMessage ? `${code}: ${githubMessage}` : code;
    return Object.assign(new Error(message), { code, githubMessage });
}
async function fetchPullRequest(target, prNumber, options) {
    // Retry transient network errors / 5xx around this single call (#4829), matching ci-poller.js's
    // githubGetJsonResponse -- distinct from this poller's OWN outer pending-retry loop. requestTimeoutMs bounds
    // each individual attempt with a fresh AbortSignal.timeout() (a stalled connection can't hang a poll cycle
    // forever -- #miner-github-read-timeouts); the injected sleepFn keeps the retry backoff instant in tests.
    const response = await fetchWithRetry(options.fetchFn, apiUrl(options.apiBaseUrl, repoPath(target, `/pulls/${prNumber}`)), { method: "GET", headers: githubHeaders(options.githubToken) }, { sleepFn: options.sleepFn, timeoutMs: options.requestTimeoutMs });
    const payload = await response.json().catch(() => null);
    if (!response.ok)
        throw githubError(response, payload);
    return payload;
}
/** GitHub's own vocabulary is `state: "open"|"closed"` plus a separate `merged: boolean` -- "closed and not
 *  merged" is the disengaged case. A still-open PR is never terminal for this poller's purposes. */
function normalizeDisposition(payload) {
    const p = payload;
    const state = p?.state === "closed" ? "closed" : "open";
    const merged = Boolean(p?.merged);
    const closedAt = typeof p?.closed_at === "string" ? p.closed_at : null;
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
    /* v8 ignore next -- unreachable: maxAttempts is normalized to >= 1, so the final iteration always returns above. */
    return latest;
}
/**
 * Classify a real, terminal PR disposition into loop-reentry.js's own `candidate.outcome` vocabulary
 * (`"merged"|"disengaged"|"other"`). A still-open disposition (not yet resolved) classifies as `"other"` --
 * the same bucket a runMinerAttempt outcome that never opened a PR at all falls into (nothing to re-enter on
 * yet, in either case).
 */
export function classifyPrDisposition(disposition) {
    if (disposition.state !== "closed")
        return "other";
    return disposition.merged ? "merged" : "disengaged";
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoicHItZGlzcG9zaXRpb24tcG9sbGVyLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsicHItZGlzcG9zaXRpb24tcG9sbGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLDRHQUE0RztBQUM1RywyR0FBMkc7QUFDM0csOEdBQThHO0FBQzlHLGtHQUFrRztBQUNsRywyR0FBMkc7QUFDM0csZ0ZBQWdGO0FBQ2hGLEVBQUU7QUFDRixxR0FBcUc7QUFDckcsd0dBQXdHO0FBQ3hHLDRHQUE0RztBQUM1RywwR0FBMEc7QUFDMUcsaUdBQWlHO0FBRWpHLE9BQU8sRUFBRSxjQUFjLEVBQUUsTUFBTSxpQkFBaUIsQ0FBQztBQStCakQsTUFBTSxpQkFBaUIsR0FBRyx3QkFBd0IsQ0FBQztBQUNuRCxNQUFNLG9CQUFvQixHQUFHLE1BQU0sQ0FBQztBQUNwQyxNQUFNLG9CQUFvQixHQUFHLENBQUMsR0FBRyxNQUFNLENBQUM7QUFDeEMsTUFBTSxrQkFBa0IsR0FBRyxDQUFDLENBQUM7QUFDN0IsTUFBTSx1QkFBdUIsR0FBRyxNQUFNLENBQUM7QUFDdkMsTUFBTSxnQkFBZ0IsR0FBRyxZQUFZLENBQUM7QUFFdEMsU0FBUyxtQkFBbUIsQ0FBQyxLQUFjO0lBQ3pDLElBQUksS0FBSyxLQUFLLFNBQVM7UUFBRSxPQUFPLGlCQUFpQixDQUFDO0lBQ2xELElBQUksT0FBTyxLQUFLLEtBQUssUUFBUSxJQUFJLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRTtRQUFFLE9BQU8saUJBQWlCLENBQUM7SUFDekUsSUFBSSxNQUFXLENBQUM7SUFDaEIsSUFBSSxDQUFDO1FBQ0gsTUFBTSxHQUFHLElBQUksR0FBRyxDQUFDLEtBQUssQ0FBQyxJQUFJLEVBQUUsQ0FBQyxDQUFDO0lBQ2pDLENBQUM7SUFBQyxNQUFNLENBQUM7UUFDUCxNQUFNLElBQUksS0FBSyxDQUFDLHNCQUFzQixDQUFDLENBQUM7SUFDMUMsQ0FBQztJQUNELElBQUksTUFBTSxDQUFDLFFBQVEsS0FBSyxRQUFR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