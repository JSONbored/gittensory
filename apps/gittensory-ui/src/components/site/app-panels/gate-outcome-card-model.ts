// Gate-outcome breakdown maintainer-dashboard card model (#2203). UI-only display slice: the card consumes a
// gate-outcome breakdown assumed present on the maintainer-dashboard payload (shaped by the #539 dashboard
// service from gate-outcome audit events). Types + the pure fold/band helpers live here (not in the .tsx) so the
// component file exports only components (react-refresh/only-export-components).

import type { Status } from "@/components/site/control-primitives";

/** The gate-outcome slice delivered on the maintainer-dashboard payload: how the maintainer's repos' PRs resolved
 *  — auto-merged, auto-closed, or held for manual review — over a rolling window. Public-safe counts only (no
 *  scores, rewards, or wallet fields). */
export interface GateOutcomeBreakdown {
  /** PRs the gate auto-merged. */
  merged: number;
  /** PRs the gate auto-closed. */
  closed: number;
  /** PRs held for manual / maintainer review. */
  held: number;
  /** Rolling measurement window, in days. */
  windowDays: number;
}

/** The card's derived view: the raw counts, the total, and each bucket's share as a whole-number percentage. */
export interface GateOutcomeSummary {
  merged: number;
  closed: number;
  held: number;
  total: number;
  mergedPct: number;
  closedPct: number;
  heldPct: number;
}

/** Pure fold: derive the total and per-bucket percentages. An all-zero breakdown yields 0% for every bucket. */
export function summarizeGateOutcomes(breakdown: GateOutcomeBreakdown): GateOutcomeSummary {
  const total = breakdown.merged + breakdown.closed + breakdown.held;
  const pct = (n: number): number => (total > 0 ? Math.round((n / total) * 100) : 0);
  return {
    merged: breakdown.merged,
    closed: breakdown.closed,
    held: breakdown.held,
    total,
    mergedPct: pct(breakdown.merged),
    closedPct: pct(breakdown.closed),
    heldPct: pct(breakdown.held),
  };
}

/** StatusPill quality band for the held share: no outcomes yet is informational; a held share at or under 25%
 *  reads healthy (the gate decides most PRs autonomously); up to 50% warns; above that blocks (most PRs still need
 *  a human). Mirrors the Status vocabulary in control-primitives.ts. */
export function bandForGateOutcomes(breakdown: GateOutcomeBreakdown): Status {
  const total = breakdown.merged + breakdown.closed + breakdown.held;
  if (total === 0) return "info";
  const heldShare = breakdown.held / total;
  if (heldShare <= 0.25) return "ready";
  return heldShare <= 0.5 ? "warn" : "blocked";
}
