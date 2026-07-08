import { ISSUE_SLOP_WEIGHTS, SLOP_WEIGHTS, type SlopBand } from "../signals/slop";

/** MCP resource URI for the deterministic slop-rule catalog (#2237). */
export const SLOP_RULES_URI = "gittensory://slop-rules" as const;

export interface SlopBandRange {
  band: SlopBand;
  /** Inclusive slopRisk (0-100) range that maps to this band. */
  range: string;
}

export interface SlopRuleEntry {
  /** Deterministic signal code — a key of SLOP_WEIGHTS / ISSUE_SLOP_WEIGHTS. */
  code: string;
  /** slopRisk points this signal contributes when it fires. */
  weight: number;
}

export interface SlopRulesDocument {
  bands: readonly SlopBandRange[];
  pullRequestRules: readonly SlopRuleEntry[];
  issueRules: readonly SlopRuleEntry[];
}

// The fixed score bands, matching slopBandFor's documented cut-points in src/signals/slop.ts (clean=0,
// low=1-30, elevated=31-59, high=60-100). Typed as SlopBand so a renamed or removed band fails the build
// here rather than drifting silently from the detector's own union.
const SLOP_BANDS: readonly SlopBandRange[] = [
  { band: "clean", range: "0" },
  { band: "low", range: "1-30" },
  { band: "elevated", range: "31-59" },
  { band: "high", range: "60-100" },
];

/** Project the deterministic slop-signal weight maps (SLOP_WEIGHTS + ISSUE_SLOP_WEIGHTS — the single source
 *  of truth in src/signals/slop.ts) into a static, read-only catalog of rule codes, their point weights, and
 *  the score bands, so an agent can pre-plan against the detector without triggering a scoring call. Codes
 *  and weights are read straight off the const maps (no duplicated literals); adding a signal there surfaces
 *  it here automatically. */
export function buildSlopRulesDocument(): SlopRulesDocument {
  return {
    bands: SLOP_BANDS,
    pullRequestRules: Object.entries(SLOP_WEIGHTS).map(([code, weight]) => ({ code, weight })),
    issueRules: Object.entries(ISSUE_SLOP_WEIGHTS).map(([code, weight]) => ({ code, weight })),
  };
}
