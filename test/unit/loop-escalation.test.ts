import { describe, expect, it } from "vitest";
import { evaluateEscalation, type LoopEscalationInput } from "../../packages/loopover-engine/src/loop-escalation";

function decide(overrides: Partial<LoopEscalationInput> = {}): ReturnType<typeof evaluateEscalation> {
  return evaluateEscalation({ runStatus: "running", ...overrides });
}

describe("evaluateEscalation (#4806)", () => {
  it("does not escalate a healthy running loop", () => {
    expect(decide({ healthStatus: "healthy" })).toEqual({ shouldEscalate: false, action: "none", severity: "none", reasons: [] });
  });

  it("stops on an explicit kill request (highest precedence)", () => {
    const d = decide({ killRequested: true });
    expect(d).toMatchObject({ shouldEscalate: true, action: "stop", severity: "high" });
    expect(d.reasons).toContain("kill_requested");
  });

  it("routes an errored run to human review at high severity", () => {
    expect(decide({ runStatus: "error" })).toMatchObject({ action: "human_review", severity: "high", reasons: ["run_errored"] });
  });

  it("routes a critical health tier to human review at high severity", () => {
    expect(decide({ healthStatus: "critical" })).toMatchObject({ action: "human_review", severity: "high", reasons: ["health_critical"] });
  });

  it("routes an abandoned run to human review at medium severity", () => {
    expect(decide({ runStatus: "abandoned" })).toMatchObject({ action: "human_review", severity: "medium", reasons: ["run_abandoned"] });
  });

  it("routes a customer-flagged loop to human review at medium severity", () => {
    expect(decide({ customerFlagged: true })).toMatchObject({ action: "human_review", severity: "medium", reasons: ["customer_flagged"] });
  });

  it("only notifies on a soft degradation", () => {
    expect(decide({ healthStatus: "degraded" })).toMatchObject({ action: "notify", severity: "low", reasons: ["health_degraded"] });
  });

  it("surfaces every triggering reason and takes the highest-precedence action", () => {
    const d = evaluateEscalation({ runStatus: "error", healthStatus: "degraded", customerFlagged: true, killRequested: true });
    expect(d.action).toBe("stop"); // kill request wins
    expect(d.reasons).toEqual(expect.arrayContaining(["kill_requested", "run_errored", "customer_flagged", "health_degraded"]));
    expect(d.reasons).not.toContain("run_abandoned"); // runStatus is error, not abandoned
    expect(d.reasons).not.toContain("health_critical"); // health is degraded, not critical
  });
});
