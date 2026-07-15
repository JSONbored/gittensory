import { describe, expect, it } from "vitest";

import { evaluateEscalation } from "../../packages/loopover-engine/src/loop-escalation";
import {
  buildActiveLoopFleetSummary,
  LOOP_HEALTH_TIERS,
  LOOP_RUN_STATUSES,
  type ActiveLoopFacts,
} from "../../packages/loopover-engine/src/loop-fleet-summary";

const loop = (over: Partial<ActiveLoopFacts> = {}): ActiveLoopFacts => ({
  loopId: "loop-1",
  tenantId: "acme",
  runStatus: "running",
  healthStatus: "healthy",
  ...over,
});

describe("buildActiveLoopFleetSummary (#4808)", () => {
  // The acceptance criterion: an operator sees every currently active rented loop and its status at a glance.
  it("counts the live fleet and breaks it down by run status and health", () => {
    const summary = buildActiveLoopFleetSummary([
      loop({ loopId: "a" }),
      loop({ loopId: "b" }),
      loop({ loopId: "c", runStatus: "converged" }), // finished cleanly, so still healthy
      loop({ loopId: "d", runStatus: "error", healthStatus: "critical" }),
      loop({ loopId: "e", runStatus: "abandoned", healthStatus: "degraded" }),
    ]);

    expect(summary.activeCount).toBe(2); // only the running ones are "currently active"
    expect(summary.totalCount).toBe(5);
    expect(summary.byStatus).toEqual({ running: 2, converged: 1, abandoned: 1, error: 1 });
    // Health is independent of run status: the converged loop is healthy too, so healthy counts a+b+c.
    expect(summary.byHealth).toEqual({ critical: 1, degraded: 1, healthy: 3, unknown: 0 });
  });

  it("an empty fleet totals to zeros, never undefined", () => {
    const summary = buildActiveLoopFleetSummary([]);
    expect(summary.activeCount).toBe(0);
    expect(summary.totalCount).toBe(0);
    expect(summary.needingAttention).toEqual([]);
    expect(summary.loops).toEqual([]);
  });

  it("INVARIANT: every status and tier key is always present, so a panel never renders a hole", () => {
    const summary = buildActiveLoopFleetSummary([]);
    expect(Object.keys(summary.byStatus).sort()).toEqual([...LOOP_RUN_STATUSES].sort());
    expect(Object.keys(summary.byHealth).sort()).toEqual([...LOOP_HEALTH_TIERS, "unknown"].sort());
    expect(Object.values(summary.byStatus).every((n) => n === 0)).toBe(true);
    expect(Object.values(summary.byHealth).every((n) => n === 0)).toBe(true);
  });

  it("a loop with no computed health tier reads as unknown, never assumed healthy", () => {
    const summary = buildActiveLoopFleetSummary([loop({ healthStatus: undefined })]);
    expect(summary.loops[0]!.healthStatus).toBe("unknown");
    expect(summary.byHealth.unknown).toBe(1);
    expect(summary.byHealth.healthy).toBe(0);
  });

  describe("needsAttention", () => {
    it("surfaces only the loops that need a human, worst-severity first", () => {
      const summary = buildActiveLoopFleetSummary([
        loop({ loopId: "healthy-one" }),
        loop({ loopId: "degraded-one", healthStatus: "degraded" }), // low → notify
        loop({ loopId: "killed-one", killRequested: true }), // high → stop
        loop({ loopId: "abandoned-one", runStatus: "abandoned" }), // medium → human_review
      ]);

      expect(summary.needingAttention.map((r) => r.loopId)).toEqual(["killed-one", "abandoned-one", "degraded-one"]);
      expect(summary.needingAttention.map((r) => r.escalation.severity)).toEqual(["high", "medium", "low"]);
      expect(summary.needingAttention.every((r) => r.needsAttention)).toBe(true);
    });

    it("a fully healthy fleet needs no attention", () => {
      const summary = buildActiveLoopFleetSummary([loop({ loopId: "a" }), loop({ loopId: "b" })]);
      expect(summary.needingAttention).toEqual([]);
      expect(summary.loops.every((r) => r.needsAttention === false)).toBe(true);
      expect(summary.loops.every((r) => r.escalation.action === "none")).toBe(true);
    });

    // The point of reusing evaluateEscalation instead of re-deciding: the fleet view and the per-loop
    // escalation path (#4806) cannot drift apart about what "needs a human" means.
    it("INVARIANT: each row's decision IS evaluateEscalation's own, not a second opinion", () => {
      const facts = loop({ loopId: "x", runStatus: "error", healthStatus: "critical", customerFlagged: true });
      const row = buildActiveLoopFleetSummary([facts]).loops[0]!;
      expect(row.escalation).toEqual(evaluateEscalation(facts));
      expect(row.needsAttention).toBe(evaluateEscalation(facts).shouldEscalate);
    });
  });

  describe("stable ordering (an operator's panel must not reshuffle between renders)", () => {
    it("breaks severity ties by loopId, deterministically", () => {
      const summary = buildActiveLoopFleetSummary([
        loop({ loopId: "zeta", runStatus: "abandoned" }),
        loop({ loopId: "alpha", runStatus: "abandoned" }),
        loop({ loopId: "mid", runStatus: "abandoned" }),
      ]);
      expect(summary.needingAttention.map((r) => r.loopId)).toEqual(["alpha", "mid", "zeta"]);
    });

    it("input order never changes the output", () => {
      const loops = [loop({ loopId: "b", healthStatus: "degraded" }), loop({ loopId: "a", runStatus: "error" }), loop({ loopId: "c" })];
      const forward = buildActiveLoopFleetSummary(loops);
      const reversed = buildActiveLoopFleetSummary([...loops].reverse());
      expect(reversed).toEqual(forward);
    });

    it("does not mutate the caller's array", () => {
      const loops = [loop({ loopId: "z" }), loop({ loopId: "a", runStatus: "error" })];
      const before = loops.map((l) => l.loopId);
      buildActiveLoopFleetSummary(loops);
      expect(loops.map((l) => l.loopId)).toEqual(before);
    });
  });

  it("keeps each loop attributed to its own tenant, so ops can see whose loop is misbehaving", () => {
    const summary = buildActiveLoopFleetSummary([
      loop({ loopId: "a", tenantId: "acme", runStatus: "error" }),
      loop({ loopId: "b", tenantId: "globex" }),
    ]);
    expect(summary.loops.find((r) => r.loopId === "a")!.tenantId).toBe("acme");
    expect(summary.loops.find((r) => r.loopId === "b")!.tenantId).toBe("globex");
    expect(summary.needingAttention.map((r) => r.tenantId)).toEqual(["acme"]);
  });
});
