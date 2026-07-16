import { describe, expect, it } from "vitest";

import { decideNextActionWithReason, type IterationState } from "../../packages/loopover-engine/src/index";

// Codecov measures packages/loopover-engine/src/** ONLY through root vitest (never the engine's own node:test
// suite), so the #6560 autonomy narrowing of decideNextAction's step-3 pass->handoff branch is exercised here
// as well as in packages/loopover-engine/test/iterate-policy.test.ts.

function passingState(overrides: Partial<IterationState> = {}): IterationState {
  return {
    iterationNumber: 1,
    maxIterations: 5,
    selfReview: { kind: "pass" },
    previousBlockerCodes: null,
    rejectionSignaled: false,
    ...overrides,
  };
}

describe("decideNextActionWithReason autonomy narrowing (#6560)", () => {
  it("auto: a clean pass hands off unconditionally, no requiresApproval", () => {
    const decision = decideNextActionWithReason(passingState({ autonomyLevel: "auto" }));
    expect(decision.action).toBe("handoff");
    expect(decision.requiresApproval).toBeUndefined();
  });

  it("auto_with_approval: a clean pass still hands off, but flags requiresApproval:true", () => {
    const decision = decideNextActionWithReason(passingState({ autonomyLevel: "auto_with_approval" }));
    expect(decision.action).toBe("handoff");
    expect(decision.requiresApproval).toBe(true);
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it("observe: a clean pass abandons observe-only with autonomy_observe_only", () => {
    const decision = decideNextActionWithReason(passingState({ autonomyLevel: "observe" }));
    expect(decision.action).toBe("abandon");
    expect(decision.abandonReason).toBe("autonomy_observe_only");
    expect(decision.requiresApproval).toBeUndefined();
    // The reason must note the pass WAS reached but the level keeps the loop observe-only.
    expect(decision.reason).toMatch(/clean predicted-gate pass/);
    expect(decision.reason).toMatch(/observe-only/);
  });

  it("REGRESSION: an omitted autonomyLevel is deep-equal to an explicit \"auto\" on the same passing state", () => {
    const omitted = decideNextActionWithReason(passingState());
    const explicitAuto = decideNextActionWithReason(passingState({ autonomyLevel: "auto" }));
    expect(omitted.action).toBe("handoff");
    expect(omitted).toEqual(explicitAuto);
  });

  it("REGRESSION: an explicitly-undefined autonomyLevel is deep-equal to an explicit \"auto\"", () => {
    const explicitUndefined = decideNextActionWithReason(passingState({ autonomyLevel: undefined }));
    const explicitAuto = decideNextActionWithReason(passingState({ autonomyLevel: "auto" }));
    expect(explicitUndefined).toEqual(explicitAuto);
  });

  it("rejectionSignaled wins over ANY autonomy level, including observe (step 1 is unreachable-by-autonomy)", () => {
    for (const autonomyLevel of ["auto", "auto_with_approval", "observe"] as const) {
      const decision = decideNextActionWithReason(passingState({ rejectionSignaled: true, autonomyLevel }));
      expect(decision.action).toBe("abandon");
      expect(decision.abandonReason).toBe("rejection_signaled");
    }
  });

  it("an ambiguous self-review wins over ANY autonomy level, including observe (step 2 is unreachable-by-autonomy)", () => {
    for (const autonomyLevel of ["auto", "auto_with_approval", "observe"] as const) {
      const decision = decideNextActionWithReason(passingState({ selfReview: { kind: "ambiguous" }, autonomyLevel }));
      expect(decision.action).toBe("abandon");
      expect(decision.abandonReason).toBe("self_review_ambiguous");
    }
  });
});
