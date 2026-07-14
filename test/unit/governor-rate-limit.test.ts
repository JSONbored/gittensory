import { describe, expect, it } from "vitest";
import { evaluateLocalRateLimit, jitteredBackoffMs, type LocalRateBucket, type LocalRateLimitConfig } from "../../packages/loopover-engine/src/governor/rate-limit";

const config: LocalRateLimitConfig = { limit: 10, windowMs: 60_000 };

describe("evaluateLocalRateLimit", () => {
  it("permits an event when the bucket is under the limit", () => {
    const bucket: LocalRateBucket = { count: 3, windowStartMs: 1_000 };
    const d = evaluateLocalRateLimit(bucket, config, 5_000);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(6); // 10 - 3 - 1
    expect(d.retryAfterMs).toBe(0);
    expect(d.resetAtMs).toBe(61_000); // windowStart 1000 + 60000
    expect(d.limit).toBe(10);
  });

  it("blocks and reports retry timing when the bucket is at the limit", () => {
    const bucket: LocalRateBucket = { count: 10, windowStartMs: 1_000 };
    const d = evaluateLocalRateLimit(bucket, config, 5_000);
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(0);
    expect(d.resetAtMs).toBe(61_000);
    expect(d.retryAfterMs).toBe(56_000); // 61000 - 5000
  });

  it("treats a fully elapsed window as reset, permitting a previously maxed bucket", () => {
    const bucket: LocalRateBucket = { count: 10, windowStartMs: 1_000 };
    const d = evaluateLocalRateLimit(bucket, config, 61_000); // exactly one window later → elapsed (>=)
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(9); // fresh window: 10 - 0 - 1
    expect(d.resetAtMs).toBe(121_000); // new window starts at now
    expect(d.retryAfterMs).toBe(0);
  });

  it("permits within a window that has not yet elapsed", () => {
    const bucket: LocalRateBucket = { count: 10, windowStartMs: 1_000 };
    const d = evaluateLocalRateLimit(bucket, config, 60_999); // 1ms before elapse → still blocked window
    expect(d.allowed).toBe(false);
    expect(d.retryAfterMs).toBe(1); // 61000 - 60999
  });

  it("clamps a negative stored count to zero", () => {
    const bucket: LocalRateBucket = { count: -5, windowStartMs: 1_000 };
    const d = evaluateLocalRateLimit(bucket, config, 5_000);
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(9); // treated as count 0
  });

  it("blocks when the stored count exceeds the limit", () => {
    const bucket: LocalRateBucket = { count: 15, windowStartMs: 1_000 };
    const d = evaluateLocalRateLimit(bucket, config, 5_000);
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(0);
  });

  it("floors a fractional stored count instead of leaking a fractional remaining", () => {
    const d = evaluateLocalRateLimit({ count: 3.9, windowStartMs: 1_000 }, config, 5_000);
    expect(d.remaining).toBe(6); // 3.9 floored to 3 → 10 - 3 - 1
    expect(Number.isInteger(d.remaining)).toBe(true);
  });

  it("normalizes non-finite numeric inputs so the decision is never NaN or negative", () => {
    const d = evaluateLocalRateLimit({ count: NaN, windowStartMs: NaN }, { limit: NaN, windowMs: NaN }, NaN);
    for (const value of [d.limit, d.remaining, d.resetAtMs, d.retryAfterMs]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(typeof d.allowed).toBe("boolean");
  });

  it("clamps a non-positive window to a defined always-reset decision", () => {
    // windowMs -10 clamps to 0 → the window is always elapsed → a fresh window opens at now, permitting the event.
    const d = evaluateLocalRateLimit({ count: 0, windowStartMs: 1_000 }, { limit: 5, windowMs: -10 }, 5_000);
    expect(d).toEqual({ allowed: true, limit: 5, remaining: 4, resetAtMs: 5_000, retryAfterMs: 0 });
  });
});

describe("jitteredBackoffMs", () => {
  it("returns the base delay at attempt 0 with a mid jitter draw", () => {
    expect(jitteredBackoffMs(100, 0, () => 0.5)).toBe(100); // 100 * 2^0 * (0.5 + 0.5)
  });

  it("grows exponentially with the attempt count", () => {
    expect(jitteredBackoffMs(100, 3, () => 0.5)).toBe(800); // 100 * 2^3 * 1.0
  });

  it("keeps the jitter factor within the [0.5, 1.5) band across a swept attempt range", () => {
    for (let attempt = 0; attempt <= 12; attempt++) {
      const exp = 100 * 2 ** attempt;
      const low = jitteredBackoffMs(100, attempt, () => 0);
      const high = jitteredBackoffMs(100, attempt, () => 0.999999);
      expect(low).toBe(Math.round(exp * 0.5));
      expect(high).toBeGreaterThanOrEqual(Math.round(exp * 0.5));
      expect(high).toBeLessThan(Math.round(exp * 1.5) + 1);
    }
  });

  it("clamps a negative attempt to zero", () => {
    expect(jitteredBackoffMs(100, -4, () => 0.5)).toBe(100);
  });

  it("floors a fractional attempt", () => {
    expect(jitteredBackoffMs(100, 2.9, () => 0.5)).toBe(400); // floor(2.9) = 2 → 2^2
  });

  it("caps the exponent so a pathological attempt cannot overflow to Infinity", () => {
    const capped = jitteredBackoffMs(1, 1000, () => 0.5);
    expect(Number.isFinite(capped)).toBe(true);
    expect(capped).toBe(Math.round(2 ** 30)); // 1 * 2^30 * 1.0
  });

  it("treats a negative base as zero", () => {
    expect(jitteredBackoffMs(-100, 5, () => 0.9)).toBe(0);
  });

  it("clamps an out-of-contract random draw into the band", () => {
    expect(jitteredBackoffMs(100, 0, () => 5)).toBe(Math.round(100 * (0.5 + 0.999999))); // draw clamped to 0.999999
    expect(jitteredBackoffMs(100, 0, () => -3)).toBe(50); // draw clamped to 0 → factor 0.5
  });

  it("treats a non-finite random draw as zero so the delay never becomes NaN", () => {
    expect(jitteredBackoffMs(100, 0, () => NaN)).toBe(50); // NaN draw → 0 → factor 0.5
    expect(jitteredBackoffMs(100, 2, () => Number.POSITIVE_INFINITY)).toBe(200); // Infinity draw → 0 → 400 * 0.5
  });

  it("treats a non-finite base or attempt as zero so the result stays a non-negative integer", () => {
    expect(jitteredBackoffMs(NaN, 0, () => 0.5)).toBe(0); // base NaN → 0
    expect(jitteredBackoffMs(Number.POSITIVE_INFINITY, 0, () => 0.5)).toBe(0); // base Infinity → 0
    expect(jitteredBackoffMs(100, NaN, () => 0.5)).toBe(100); // attempt NaN → exponent 0 → 100
    expect(jitteredBackoffMs(100, Number.POSITIVE_INFINITY, () => 0.5)).toBe(Math.round(2 ** 30 * 100)); // attempt ∞ → capped exponent
  });

  it("rounds a fractional base to an integer delay", () => {
    expect(jitteredBackoffMs(0.1, 0, () => 0.5)).toBe(0); // round(0.1 * 1) = 0
    expect(jitteredBackoffMs(1.9, 0, () => 0.5)).toBe(2); // round(1.9 * 1) = 2
    expect(Number.isInteger(jitteredBackoffMs(2.5, 3, () => 0.7))).toBe(true);
  });

  it("clamps an overflowing result to a finite integer instead of returning Infinity", () => {
    const result = jitteredBackoffMs(Number.MAX_VALUE, 30, () => 0.5); // MAX_VALUE * 2^30 overflows to Infinity
    expect(Number.isFinite(result)).toBe(true);
    expect(result).toBe(Number.MAX_SAFE_INTEGER);
  });
});
