import { describe, expect, it } from "vitest";
import { delayToNextWallClockBoundaryMs } from "../../src/selfhost/cron-alignment";

const TWO_MINUTES_MS = 120_000;

describe("delayToNextWallClockBoundaryMs (self-host cron phase alignment)", () => {
  it("returns the delay to the next boundary when booting mid-cycle", () => {
    // 2026-07-21T20:49:04.768Z -- the exact odd-minute boot moment observed live on edge-nl-01, which
    // (with a plain, unaligned setInterval) locked every subsequent tick to odd minutes forever.
    const bootMs = Date.parse("2026-07-21T20:49:04.768Z");
    const delay = delayToNextWallClockBoundaryMs(bootMs, TWO_MINUTES_MS);
    const firstTickMs = bootMs + delay;
    expect(new Date(firstTickMs).getUTCMinutes() % 2).toBe(0);
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(TWO_MINUTES_MS);
  });

  it("waits a full interval when already exactly on a boundary, matching setInterval's no-immediate-fire semantics", () => {
    const onBoundaryMs = Date.parse("2026-07-21T20:50:00.000Z");
    expect(delayToNextWallClockBoundaryMs(onBoundaryMs, TWO_MINUTES_MS)).toBe(TWO_MINUTES_MS);
  });

  it("aligns to a minute-10/30 boundary regardless of which second within the minute it boots", () => {
    const bootMs = Date.parse("2026-07-21T20:57:43.219Z");
    const delay = delayToNextWallClockBoundaryMs(bootMs, TWO_MINUTES_MS);
    const firstTick = new Date(bootMs + delay);
    expect(firstTick.getUTCMinutes()).toBe(58);
    expect(firstTick.getUTCSeconds()).toBe(0);
    expect(firstTick.getUTCMilliseconds()).toBe(0);
  });
});
