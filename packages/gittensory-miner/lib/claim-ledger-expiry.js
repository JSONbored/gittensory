/**
 * Claim-ledger staleness/expiry sweep (#2316).
 *
 * A local miner marks an issue/PR "active" in its claim ledger while it works. If that claim is never
 * resolved (crash, abandoned run, forgotten background loop) it stays "active" forever and needlessly
 * blocks other miners from claiming or adjudicating the same work. The sweep releases such claims once
 * they age past a configurable ceiling.
 *
 * {@link findExpiredClaims} is PURE — no IO, no network, no `Date.now()`, no randomness — so the same
 * (claims, nowMs, maxAgeMs) always yields the same set and the caller supplies the clock. This mirrors
 * the disciplined pure-adjudication pattern in `src/signals/duplicate-winner.ts:10`.
 *
 * Fail-closed rule: only an "active" claim with a finite `claimedAtMs` can expire. A claim whose timing
 * is missing/malformed, or whose timestamp is in the future, is LEFT ACTIVE — we never release a claim
 * we cannot confidently age, so a corrupt row can't silently free live work.
 */

// ~14 days. Suggested default ceiling before an unresolved local claim is considered abandoned (#2316).
export const DEFAULT_CLAIM_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function isExpiredActiveClaim(claim, nowMs, maxAgeMs) {
  if (!claim || claim.status !== "active") return false;
  const claimedAtMs = claim.claimedAtMs;
  if (typeof claimedAtMs !== "number" || !Number.isFinite(claimedAtMs)) return false;
  const age = nowMs - claimedAtMs;
  // Boundary is inclusive: a claim exactly at the ceiling (age === maxAgeMs) is expired.
  return age >= maxAgeMs;
}

/**
 * Pure selector: the subset of `claims` that are active and have aged to/beyond `maxAgeMs` at `nowMs`.
 * Input order is preserved and the returned records are the same references from `claims`.
 */
export function findExpiredClaims(claims, nowMs, maxAgeMs) {
  if (!Array.isArray(claims)) throw new Error("invalid_claims");
  if (typeof nowMs !== "number" || !Number.isFinite(nowMs)) throw new Error("invalid_now_ms");
  if (typeof maxAgeMs !== "number" || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new Error("invalid_max_age_ms");
  }
  return claims.filter((claim) => isExpiredActiveClaim(claim, nowMs, maxAgeMs));
}

/**
 * Thin store wrapper: runs the pure selector over the ledger's active claims and transitions each
 * expired record to `status: "expired"` via the store's own API. Returns the records it expired.
 */
export function sweepExpiredClaims(store, nowMs, maxAgeMs = DEFAULT_CLAIM_MAX_AGE_MS) {
  if (!store || typeof store.listActiveClaims !== "function" || typeof store.expireClaim !== "function") {
    throw new Error("invalid_claim_ledger_store");
  }
  const expired = findExpiredClaims(store.listActiveClaims(), nowMs, maxAgeMs);
  for (const claim of expired) {
    store.expireClaim(claim.id, nowMs);
  }
  return expired;
}
