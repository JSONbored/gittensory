// Impact-map activation wiring (#2184, config slice of #1971). Mirrors rag-wire.ts's isRagEnabled: a single
// GLOBAL env kill-switch the self-host operator controls, ANDed with the per-repo `.gittensory.yml
// review.impact_map` manifest toggle (resolved via `resolveReviewPromptOverrides`'s `impactMap` field) — so a
// repo can only ever NARROW what the operator has already turned on, never widen it. Both OFF by default:
// with the env flag unset, impact-map computation is never invoked from the review path at all (the caller
// guards on this flag before doing any RAG query or rendering), so the review stays byte-identical to today.

/** True when impact-map computation is enabled at the operator level. Flag-OFF (default) → the caller takes
 *  no new branch, so no symbol extraction, no RAG query, and no impact-map section is ever computed or
 *  rendered. Truthy follows the codebase convention (`/^(1|true|yes|on)$/i`, same as isRagEnabled /
 *  isGroundingEnabled / isSafetyEnabled). */
export function isImpactMapEnabled(env: { GITTENSORY_REVIEW_IMPACT_MAP?: string | undefined }): boolean {
  return /^(1|true|yes|on)$/i.test(env.GITTENSORY_REVIEW_IMPACT_MAP ?? "");
}

/** Resolve whether impact-map computation should run for THIS repo/PR: the operator's global env kill-switch
 *  AND the per-repo manifest opt-in. Neither alone is sufficient — mirrors every other converged-feature gate
 *  in this codebase (env kill-switch first, then the manifest narrows it further). */
export function shouldComputeImpactMap(
  env: { GITTENSORY_REVIEW_IMPACT_MAP?: string | undefined },
  manifestImpactMapEnabled: boolean,
): boolean {
  return isImpactMapEnabled(env) && manifestImpactMapEnabled;
}
