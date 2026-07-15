// Active rented-loop fleet summary (pure) — #4808, part of the Rent-a-Loop path #4778.
//
// Deterministic and side-effect-free: given every rented loop the internal ops team currently knows about, it
// produces the at-a-glance view an operator needs — how many loops are live, how they break down by run status
// and health tier, and which ones are misbehaving badly enough to need a human right now. That is exactly
// #4808's acceptance criterion ("an internal operator can see every currently active rented loop and its status
// at a glance") as a decision core: what a dashboard panel renders and what an alert rule fires on, computed
// once, the same way, for both.
//
// It reuses loop-escalation.ts's (#4806) already-merged vocabulary rather than restating it — the same
// LoopRunOutcome/LoopHealthTier a loop is already described by, and evaluateEscalation itself to decide whether
// a given loop needs attention. So the fleet view can never disagree with the per-loop escalation path about
// what "needs a human" means: there is one rule, called once per loop, not a second copy that drifts.
//
// It summarizes only: no dashboard, no alert delivery, no IO, no clock read. Wiring panels/alert rules into the
// self-host observability stack is the separate integration this issue is blocked on (#4793) — this core has no
// opinion about Grafana or Alertmanager, so it stays correct whatever renders it.

import { evaluateEscalation, type EscalationDecision, type LoopEscalationInput, type LoopHealthTier, type LoopRunOutcome } from "./loop-escalation.js";

/** Every run status a loop can report, in the order an operator reads them (live work first). */
export const LOOP_RUN_STATUSES: readonly LoopRunOutcome[] = ["running", "converged", "abandoned", "error"];
/** Health tiers, worst-first — the order the summary surfaces them in. */
export const LOOP_HEALTH_TIERS: readonly LoopHealthTier[] = ["critical", "degraded", "healthy"];

/** One rented loop as ops currently knows it. Mirrors LoopEscalationInput's signals so the same rule applies. */
export type ActiveLoopFacts = LoopEscalationInput & {
  loopId: string;
  tenantId: string;
};

/** One row of the operator's view: the loop, plus the escalation decision computed for it. */
export type FleetLoopRow = {
  loopId: string;
  tenantId: string;
  runStatus: LoopRunOutcome;
  /** Absent when nothing has computed a health tier for this loop yet — reported as "unknown", never guessed. */
  healthStatus: LoopHealthTier | "unknown";
  needsAttention: boolean;
  escalation: EscalationDecision;
};

export type ActiveLoopFleetSummary = {
  /** Loops still running — the "currently active" count an operator reads first. */
  activeCount: number;
  /** Every loop handed in, however it ended. */
  totalCount: number;
  /** Count per run status. Every status is always present (0 when none), so a panel never renders a hole. */
  byStatus: Record<LoopRunOutcome, number>;
  /** Count per health tier, plus `unknown` for loops with no tier computed yet. Always fully populated. */
  byHealth: Record<LoopHealthTier | "unknown", number>;
  /** Loops needing a human, worst-first — what an alert rule fires on. A subset of `loops`, never a copy that drifts. */
  needingAttention: FleetLoopRow[];
  /** Every loop, in a stable order. */
  loops: FleetLoopRow[];
};

/** Highest severity first; ties broken by loopId so the view is stable across renders, never reshuffled. */
const SEVERITY_RANK: Record<EscalationDecision["severity"], number> = { high: 0, medium: 1, low: 2, none: 3 };

function compareRows(a: FleetLoopRow, b: FleetLoopRow): number {
  const bySeverity = SEVERITY_RANK[a.escalation.severity] - SEVERITY_RANK[b.escalation.severity];
  return bySeverity !== 0 ? bySeverity : a.loopId.localeCompare(b.loopId);
}

function toRow(loop: ActiveLoopFacts): FleetLoopRow {
  const escalation = evaluateEscalation(loop);
  return {
    loopId: loop.loopId,
    tenantId: loop.tenantId,
    runStatus: loop.runStatus,
    healthStatus: loop.healthStatus ?? "unknown",
    needsAttention: escalation.shouldEscalate,
    escalation,
  };
}

/**
 * Summarize the rented-loop fleet for the internal ops view (#4808). Pure: reads only the loops it is handed
 * and returns a summary without mutating, fetching, or notifying anything.
 *
 * `needsAttention` is not a second opinion — each row's flag IS evaluateEscalation's own `shouldEscalate` for
 * that loop, so the fleet view and the per-loop escalation path (#4806) can never disagree about what needs a
 * human. `needingAttention` is those rows, worst-severity first, with ties broken by `loopId` so an operator
 * watching the panel sees a stable order rather than rows reshuffling between renders.
 *
 * Both breakdowns are always fully populated (0 for an absent status/tier) so a panel binds to a fixed set of
 * keys and never renders a hole. A loop with no health tier computed yet counts as `unknown` rather than being
 * assumed healthy — an operator must be able to tell "nothing is wrong" from "nothing has checked yet".
 */
export function buildActiveLoopFleetSummary(loops: readonly ActiveLoopFacts[]): ActiveLoopFleetSummary {
  const byStatus = Object.fromEntries(LOOP_RUN_STATUSES.map((s) => [s, 0])) as Record<LoopRunOutcome, number>;
  const byHealth = Object.fromEntries([...LOOP_HEALTH_TIERS, "unknown"].map((h) => [h, 0])) as Record<LoopHealthTier | "unknown", number>;

  const rows = loops.map(toRow);
  for (const row of rows) {
    byStatus[row.runStatus] += 1;
    byHealth[row.healthStatus] += 1;
  }

  return {
    activeCount: byStatus.running,
    totalCount: rows.length,
    byStatus,
    byHealth,
    needingAttention: rows.filter((row) => row.needsAttention).sort(compareRows),
    loops: [...rows].sort(compareRows),
  };
}
