// System clock-drift detection (#3811). edge-us-01's system clock silently drifted ~3 minutes off true
// time because its sole configured NTP source was dead (`chronyc sources` showed Reach: 0 the whole
// time, no redundant fallback), breaking GitHub App JWT auth ("Bad credentials") for a window before
// anyone noticed. GitHub App JWTs are signed with iat/exp derived from the local clock (createAppJwt,
// src/github/app.ts), so drift shows up there first. Rather than spend a network round-trip just to
// check the clock, this piggybacks on the `Date` response header of the JWT-authenticated
// installation-token mint call that's ALREADY made whenever a token needs (re-)minting -- no new
// outbound request, sampled at exactly the cadence the vulnerable code path itself runs.

let lastSkewSeconds = 0;
// Wall-clock time (ms) of the last SUCCESSFUL skew sample, or null until the first one (#7000). Because a
// sample is only taken when a JWT token mint call observes a `Date` header, a long-lived cached/broker-provided
// token can mean no mint (and thus no fresh sample) for a while — during which `lastSkewSeconds` keeps reporting
// an old reading as if it were current. Tracking the sample time lets the metric expose that staleness.
let lastSampleAtMs: number | null = null;

/**
 * Update the last-observed clock-skew sample from a GitHub response's `Date` header. Positive means
 * this process's clock is AHEAD of GitHub's; negative means it's BEHIND. A missing or unparseable
 * header is ignored (the previous sample is left in place) rather than reset to 0, so one malformed
 * response can never mask real drift until the next successful sample.
 */
export function recordClockSkewFromResponse(response: Response): void {
  const dateHeader = response.headers.get("date");
  if (!dateHeader) return;
  const remoteMs = Date.parse(dateHeader);
  if (!Number.isFinite(remoteMs)) return;
  lastSkewSeconds = (Date.now() - remoteMs) / 1000;
  lastSampleAtMs = Date.now();
}

/** The most recently observed clock-skew sample in seconds (0 until the first successful sample). */
export function clockSkewSecondsSample(): number {
  return lastSkewSeconds;
}

/**
 * Age in seconds since the last successful clock-skew sample, or `-1` when no sample has been taken yet (#7000).
 * The `-1` sentinel follows the same "no reading available" convention `d1-size-probe.ts` and
 * `loopover_host_load_avg1_per_core` use, so an operator can distinguish a fresh reading from a stale one
 * instead of an old sample silently looking current.
 */
export function clockSkewSampleAgeSeconds(): number {
  if (lastSampleAtMs === null) return -1;
  return (Date.now() - lastSampleAtMs) / 1000;
}

/** Test-only: reset the module-level sample state between tests. */
export function resetClockSkewForTest(): void {
  lastSkewSeconds = 0;
  lastSampleAtMs = null;
}
