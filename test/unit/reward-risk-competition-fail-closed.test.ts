import { describe, expect, it } from "vitest";
import { computeOpportunityCompetition } from "../../packages/loopover-engine/src/opportunity-competition";
import { rewardRiskCompetitionInternals } from "../../src/signals/reward-risk";

const { opportunityCompetitionFactor } = rewardRiskCompetitionInternals;

/**
 * #7529: the hosted `opportunityCompetitionFactor` fed both arguments straight into
 * `clamp(clusters / Math.max(1, openPrs), 0, 1)`. A non-finite `openPullRequests` made `Math.max(1, NaN)`
 * NaN, which clamp's own Math.min/Math.max then propagated, so the factor came back NaN instead of a
 * bounded score. Its pure mirror `computeOpportunityCompetition` already guarded both inputs; these tests
 * pin the hosted path to that same fail-closed contract so the two cannot drift apart again.
 */
describe("opportunityCompetitionFactor fail-closed guards (#7529)", () => {
  it("never returns NaN for a non-finite open-PR count", () => {
    for (const openPrs of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const factor = opportunityCompetitionFactor(2, openPrs);
      expect(Number.isFinite(factor)).toBe(true);
      expect(factor).toBeGreaterThanOrEqual(0);
      expect(factor).toBeLessThanOrEqual(1);
    }
  });

  it("fails CLOSED to maximal pressure when the duplicate-cluster signal is broken", () => {
    // A broken cluster signal means "unknown risk", which must read as maximum competition (1), not 0 --
    // otherwise a NaN upstream reading would silently look like a wide-open opportunity.
    for (const clusters of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(opportunityCompetitionFactor(clusters, 10)).toBe(1);
    }
  });

  it("treats a negative reading as zero pressure rather than a negative factor", () => {
    expect(opportunityCompetitionFactor(-5, 10)).toBe(0);
    expect(opportunityCompetitionFactor(2, -10)).toBe(1);
  });

  it("is unchanged for ordinary finite inputs", () => {
    expect(opportunityCompetitionFactor(0, 10)).toBe(0);
    expect(opportunityCompetitionFactor(1, 4)).toBe(0.25);
    expect(opportunityCompetitionFactor(3, 4)).toBe(0.75);
    // Clamped at 1 when clusters exceed open PRs, and Math.max(1, …) floors the divisor at 1.
    expect(opportunityCompetitionFactor(9, 4)).toBe(1);
    expect(opportunityCompetitionFactor(1, 0)).toBe(1);
  });

  it("agrees with the pure mirror it delegates to, across the whole input matrix", () => {
    const values = [0, 1, 2, 3, 9, -5, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const clusters of values) {
      for (const openPrs of values) {
        expect(opportunityCompetitionFactor(clusters, openPrs)).toBe(
          computeOpportunityCompetition(clusters, openPrs),
        );
      }
    }
  });
});
