/** Milliseconds from `nowMs` until the next wall-clock boundary of `intervalMs`, so a self-host `setTimeout`
 *  can phase-align its first tick to the same instants Cloudflare's own cron trigger would fire on (e.g. the
 *  every-2-minutes trigger fires exactly at :00, :02, :04, … UTC). Computed against epoch -- itself minute-aligned --
 *  rather than the caller's own boot time, since `nowMs % intervalMs` only lands on true minute boundaries
 *  (matching what `enqueueScheduledJobs`'s `getUTCMinutes()`-based gates check) when measured from a fixed,
 *  minute-aligned origin; measuring from an arbitrary boot moment would just reproduce the exact bug this
 *  exists to fix (see server.ts's cron setup). Exactly on a boundary already (`nowMs % intervalMs === 0`)
 *  waits a FULL intervalMs rather than firing immediately, matching `setInterval`'s own "no immediate first
 *  fire" semantics the caller is replacing. */
export function delayToNextWallClockBoundaryMs(nowMs: number, intervalMs: number): number {
  const msIntoCycle = nowMs % intervalMs;
  return msIntoCycle === 0 ? intervalMs : intervalMs - msIntoCycle;
}
