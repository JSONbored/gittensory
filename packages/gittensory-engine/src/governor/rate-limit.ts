// Governor local rate-limit + jittered backoff (pure).
// Deterministic, side-effect-free bucket math for the local Governor. Given a rolling-window bucket and a
// clock reading it decides whether an event is allowed and, when blocked, how long to wait; and it computes a
// jittered exponential backoff from an INJECTED random source (never Math.random) so it stays fully unit-
// testable. This module computes numbers only — it does NOT store state, schedule, or gate any write action;
// that enforcement wiring is a separate, maintainer-owned concern. The vocabulary mirrors the server-side
// `RateLimitConfig`/`RateLimitDecision` in src/auth/rate-limit.ts (that one is a Cloudflare Durable Object and
// is not reusable in the fully-local miner), but this variant is millisecond-based and state-free.

export type LocalRateLimitConfig = {
  /** Maximum number of events permitted within one window. */
  limit: number;
  /** Rolling window length in milliseconds. */
  windowMs: number;
};

export type LocalRateBucket = {
  /** Events already counted in the current window. */
  count: number;
  /** Start of the current window as a millisecond epoch. */
  windowStartMs: number;
};

export type LocalRateLimitDecision = {
  /** Whether an event at `nowMs` is permitted under the bucket + config. */
  allowed: boolean;
  /** The configured limit, echoed for callers that render the decision. */
  limit: number;
  /** Events still permitted in the effective window AFTER this one (0 when blocked). */
  remaining: number;
  /** When the effective window resets, as a millisecond epoch. */
  resetAtMs: number;
  /** Milliseconds to wait before the next permitted attempt (0 when allowed). */
  retryAfterMs: number;
};

// Cap the backoff exponent so `2 ** attempt` cannot overflow into Infinity for a pathological attempt count;
// beyond this the delay is already saturated at its ceiling anyway.
const MAX_BACKOFF_EXPONENT = 30;

// Normalize any numeric input to a non-negative integer (a non-finite or negative value becomes 0), so counts,
// limits, and window lengths can never make a decision NaN, fractional, or negative.
function finiteNonNegativeInt(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Decide whether an event at `nowMs` is allowed for a rolling-window bucket. Pure: it reads the bucket and
 * clock and returns a decision without mutating anything. A window that has fully elapsed is treated as reset,
 * so a stale bucket at its limit is permitted again in the new window. Every numeric input is normalized first,
 * so a non-finite, fractional, or negative count/limit/window can never produce a NaN or negative decision.
 */
export function evaluateLocalRateLimit(
  bucket: LocalRateBucket,
  config: LocalRateLimitConfig,
  nowMs: number,
): LocalRateLimitDecision {
  const limit = finiteNonNegativeInt(config.limit);
  const windowMs = finiteNonNegativeInt(config.windowMs);
  const count = finiteNonNegativeInt(bucket.count);
  const windowStartMs = Number.isFinite(bucket.windowStartMs) ? bucket.windowStartMs : 0;
  const now = Number.isFinite(nowMs) ? nowMs : 0;

  const windowElapsed = now - windowStartMs >= windowMs;
  const effectiveCount = windowElapsed ? 0 : count;
  const effectiveWindowStart = windowElapsed ? now : windowStartMs;
  const resetAtMs = effectiveWindowStart + windowMs;

  const allowed = effectiveCount < limit;
  const remaining = allowed ? limit - effectiveCount - 1 : 0;
  const retryAfterMs = allowed ? 0 : Math.max(0, resetAtMs - now);

  return { allowed, limit, remaining, resetAtMs, retryAfterMs };
}

/**
 * Compute a jittered exponential backoff in milliseconds for a retry `attempt` (0-based). The exponential base
 * is `baseMs * 2 ** attempt` (attempt clamped to a non-negative, bounded range), scaled by a multiplicative
 * jitter factor drawn from `randomFn` (expected to return a value in [0, 1), like `Math.random`, but injected
 * so tests stay deterministic): the factor lands in [0.5, 1.5), and the final delay is that product rounded to
 * the nearest integer (so at the top of the band a delay may round up to the `1.5 * base` value). The result is
 * always a non-negative integer.
 */
export function jitteredBackoffMs(baseMs: number, attempt: number, randomFn: () => number): number {
  // Normalize non-finite inputs so the result can never be NaN or Infinity — it is always a non-negative integer,
  // matching this function's documented contract. A non-finite base is treated as 0; a NaN attempt means no
  // backoff growth, while a huge or Infinity attempt saturates at the capped exponent.
  const safeBase = Number.isFinite(baseMs) ? Math.max(0, baseMs) : 0;
  const exponent = Number.isNaN(attempt) ? 0 : Math.min(MAX_BACKOFF_EXPONENT, Math.max(0, Math.floor(attempt)));
  const exponential = safeBase * 2 ** exponent;
  // Clamp the random draw into [0, 1) so an out-of-contract source cannot push the factor outside [0.5, 1.5).
  // A non-finite draw (e.g. NaN) is treated as 0 so the delay never becomes NaN.
  const rawDraw = randomFn();
  const draw = Number.isFinite(rawDraw) ? Math.min(0.999999, Math.max(0, rawDraw)) : 0;
  const jitterFactor = 0.5 + draw;
  // Round to an integer AND guard finiteness on the return itself: a fractional base yields a rounded integer,
  // and an extreme (but finite) base that overflows the multiplication to Infinity falls back to a finite max —
  // so the result is always a non-negative integer for any input, per the documented contract.
  const rawDelay = exponential * jitterFactor;
  return Number.isFinite(rawDelay) ? Math.max(0, Math.round(rawDelay)) : Number.MAX_SAFE_INTEGER;
}
