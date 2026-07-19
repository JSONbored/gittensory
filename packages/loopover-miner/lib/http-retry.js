// Bounded retry-with-backoff around a single HTTP call (#4829). The miner's pollers (ci-poller and others)
// previously let a single brief 5xx from GitHub kill the whole poll loop, because their own attempt loop
// only re-polls while a conclusion is genuinely "pending", never after a server error. This wraps ONE fetch so a
// transient SERVER error (a 5xx RESPONSE) or a transient GitHub RATE-LIMIT response (429 / secondary-403, #6761)
// is retried a bounded number of times, DISTINCT from that pending-polling, sleeping an exponential backoff (or
// the response's `Retry-After`, whichever is longer) between attempts and giving up after `maxAttempts`. Any other
// 2xx/3xx/4xx response — including a plain permission 403 — is returned immediately, and a THROWN error (a network-
// level failure) propagates unchanged rather than being retried — the pollers' existing failure-mode contract
// (#4281) deliberately bubbles those to the caller.
// Pure control flow over injected `fetchFn`/`sleepFn`/`backoffMs` — no real network or timers in tests.
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
/** Clamp `maxAttempts` to a positive integer, flooring BEFORE the positivity test so a fractional value below 1
 *  falls back to the default rather than becoming a 0 that would skip every attempt. */
function normalizeMaxAttempts(raw) {
    const numeric = Math.floor(Number(raw));
    return Number.isFinite(numeric) && numeric >= 1 ? numeric : DEFAULT_MAX_ATTEMPTS;
}
/** Exponential backoff from a base delay, capped: attempt 1 → base, 2 → 2×base, 3 → 4×base, … ≤ MAX_BACKOFF_MS. */
export function defaultRetryBackoffMs(attempt) {
    return Math.min(MAX_BACKOFF_MS, DEFAULT_BASE_BACKOFF_MS * 2 ** (Math.max(1, attempt) - 1));
}
const defaultSleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
/** Read a response header defensively — works with a real `Headers` object or a test stub exposing `.get()`. */
function readHeader(response, name) {
    const headers = response && response.headers;
    return headers && typeof headers.get === "function" ? headers.get(name) : null;
}
/**
 * A transient GitHub rate-limit response the poll should ride out rather than abort on (#6761): a 429 (primary
 * rate limit / abuse), or a SECONDARY-rate-limit 403 — identified by a `Retry-After` header or `x-ratelimit-
 * remaining: 0`. A plain permission-denied 403 carries neither signal and is deliberately NOT treated as a rate
 * limit: it can never succeed, so retrying it would only burn the bounded attempt budget.
 */
function isRateLimitStatus(response) {
    if (response.status === 429)
        return true;
    if (response.status !== 403)
        return false;
    if (readHeader(response, "retry-after") != null)
        return true;
    const remaining = readHeader(response, "x-ratelimit-remaining");
    return remaining != null && Number(remaining) === 0;
}
/** Retry a transient SERVER error (5xx) OR a transient rate-limit response (429 / secondary-403). (#6761) */
function isRetryableStatus(response) {
    return response.status >= 500 || isRateLimitStatus(response);
}
/**
 * Delay before the next attempt. Honor a `Retry-After` header (delta-seconds) when GitHub sends one — but never
 * below the computed exponential backoff (so a tiny/zero value can't hammer) and never above MAX_BACKOFF_MS;
 * otherwise fall back to the exponential backoff alone. (#6761)
 */
function retryDelayMs(response, attempt, backoffMs) {
    const base = backoffMs(attempt);
    const retryAfterSeconds = Number(readHeader(response, "retry-after"));
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
        return Math.min(MAX_BACKOFF_MS, Math.max(base, retryAfterSeconds * 1000));
    }
    return base;
}
/**
 * Perform `fetchFn(url, init)` with bounded retry on a transient 5xx OR rate-limit (429 / secondary-403) response.
 * A retryable status is retried (sleeping `Retry-After` or `backoffMs(attempt)`, whichever is longer, between
 * attempts) up to `maxAttempts`; any other 2xx/3xx/4xx response is returned immediately, and after the last attempt
 * a lingering retryable status is returned as-is (the caller's own error handling still runs). A THROWN
 * error is NOT retried — it propagates to the caller (the pollers' #4281 failure-mode contract). When `timeoutMs`
 * is given, each attempt gets its own fresh abort timeout (a stalled connection is exactly the kind of network-
 * level failure #4281 already bubbles unretried, so a timed-out attempt propagates the same way).
 */
export async function fetchWithRetry(fetchFn, url, init, options = {}) {
    const maxAttempts = normalizeMaxAttempts(options.maxAttempts);
    const sleepFn = typeof options.sleepFn === "function" ? options.sleepFn : defaultSleep;
    const backoffMs = typeof options.backoffMs === "function" ? options.backoffMs : defaultRetryBackoffMs;
    for (let attempt = 1;; attempt += 1) {
        // A thrown error is intentionally NOT caught here — it propagates to the caller unchanged.
        const response = await fetchOnce(fetchFn, url, init, options.timeoutMs);
        // Retry transient SERVER errors (5xx) AND transient GitHub rate-limit responses (429 / secondary-403, #6761).
        // Everything else (2xx/3xx/other 4xx incl. a plain permission 403) is returned immediately; on the final
        // attempt a lingering retryable status is returned as-is so the caller's own error handling still runs.
        if (!isRetryableStatus(response) || attempt >= maxAttempts)
            return response;
        await sleepFn(retryDelayMs(response, attempt, backoffMs));
    }
}
// A fresh AbortSignal.timeout() per attempt, never one shared across retries -- reusing a single signal would
// leave every attempt after the first pre-aborted the instant it fired once. AbortSignal.timeout()'s own internal
// timer is unref'd (verified: it never keeps a short-lived CLI process alive past its own work), so unlike a raw
// setTimeout it needs no manual clearTimeout -- mirrors src/github/client.ts's timeoutFetch in the main repo. A
// no-op passthrough (no `init` copy) when `timeoutMs` is absent/non-positive, so every existing caller that
// doesn't opt in sees zero behavior change.
function fetchOnce(fetchFn, url, init, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        return fetchFn(url, init);
    return fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaHR0cC1yZXRyeS5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbImh0dHAtcmV0cnkudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsMkdBQTJHO0FBQzNHLHlHQUF5RztBQUN6RyxpSEFBaUg7QUFDakgsaUhBQWlIO0FBQ2pILGdIQUFnSDtBQUNoSCxtSEFBbUg7QUFDbkgsb0hBQW9IO0FBQ3BILDhHQUE4RztBQUM5RyxvREFBb0Q7QUFDcEQsd0dBQXdHO0FBRXhHLE1BQU0sb0JBQW9CLEdBQUcsQ0FBQyxDQUFDO0FBQy9CLE1BQU0sdUJBQXVCLEdBQUcsR0FBRyxDQUFDO0FBQ3BDLE1BQU0sY0FBYyxHQUFHLE1BQU0sQ0FBQztBQWM5Qjt3RkFDd0Y7QUFDeEYsU0FBUyxvQkFBb0IsQ0FBQyxHQUFZO0lBQ3hDLE1BQU0sT0FBTyxHQUFHLElBQUksQ0FBQyxLQUFLLENBQUMsTUFBTSxDQUFDLEdBQUcsQ0FBQyxDQUFDLENBQUM7SUFDeEMsT0FBTyxNQUFNLENBQUMsUUFBUSxDQUFDLE9BQU8sQ0FBQyxJQUFJLE9BQU8sSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDLE9BQU8sQ0FBQyxDQUFDLENBQUMsb0JBQW9CLENBQUM7QUFDbkYsQ0FBQztBQUVELG1IQUFtSDtBQUNuSCxNQUFNLFVBQVUscUJBQXFCLENBQUMsT0FBZTtJQUNuRCxPQUFPLElBQUksQ0FBQyxHQUFHLENBQUMsY0FBYyxFQUFFLHVCQUF1QixHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFLE9BQU8sQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDN0YsQ0FBQztBQUVELE1BQU0sWUFBWSxHQUFHLENBQUMsT0FBZSxFQUFpQixFQUFFLENBQUMsSUFBSSxPQUFPLENBQUMsQ0FBQyxPQUFPLEVBQUUsRUFBRSxDQUFDLFVBQVUsQ0FBQyxPQUFPLEVBQUUsT0FBTyxDQUFDLENBQUMsQ0FBQztBQUVoSCxnSEFBZ0g7QUFDaEgsU0FBUyxV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
// scoped-selection-live-verification-temporary
