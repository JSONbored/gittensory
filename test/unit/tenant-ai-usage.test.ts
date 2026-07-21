import { describe, expect, it } from "vitest";
import { recordAiUsageEvent } from "../../src/db/repositories";
import { costUsdToComputeUnits, sumTenantAiComputeUnitsSince } from "../../src/services/tenant-ai-usage";
import { createTestEnv } from "../helpers/d1";

// #7660: sumAiCostForTenantSince (src/db/repositories.ts, #7176) had zero real callers outside its own
// test file. This pins the pure USD -> compute-units conversion (mirroring
// packages/loopover-engine/src/tenant-quota.ts's TenantQuota.computeUnits shape) and the aggregation
// helper the new /v1/app/tenant-ai-usage route (src/api/routes.ts) calls.
describe("costUsdToComputeUnits (#7660)", () => {
  it("floors a positive cost to whole compute-units at $0.01 per unit", () => {
    expect(costUsdToComputeUnits(2.0)).toBe(200);
    // 12.345 USD -> 1234.5 cents -> floored, not rounded, so partial-cent spend never inflates the figure.
    expect(costUsdToComputeUnits(12.345)).toBe(1234);
  });

  it("returns 0 for a zero cost", () => {
    expect(costUsdToComputeUnits(0)).toBe(0);
  });

  it("normalizes a non-finite or negative cost to 0 rather than NaN/negative units", () => {
    expect(costUsdToComputeUnits(Number.NaN)).toBe(0);
    expect(costUsdToComputeUnits(Number.POSITIVE_INFINITY)).toBe(0);
    expect(costUsdToComputeUnits(-5)).toBe(0);
  });
});

describe("sumTenantAiComputeUnitsSince (#7660)", () => {
  const base = { feature: "ai_review", model: "claude-sonnet-5", status: "ok", estimatedNeurons: 10 };

  it("sums cost across every installation id in scope, converted to compute-units", async () => {
    const env = createTestEnv();
    await recordAiUsageEvent(env, { ...base, costUsd: 1.0, installationId: "101" });
    await recordAiUsageEvent(env, { ...base, costUsd: 2.5, installationId: "202" });
    // A different, out-of-scope tenant's spend must never be folded into this caller's total.
    await recordAiUsageEvent(env, { ...base, costUsd: 99.0, installationId: "999" });

    const computeUnits = await sumTenantAiComputeUnitsSince(env, [101, 202], "2020-01-01T00:00:00.000Z");
    expect(computeUnits).toBe(350); // (1.0 + 2.5) USD = 350 cents
  });

  it("sums to 0 when the installation-id scope is empty (a tenant with no usage/no installations)", async () => {
    const env = createTestEnv();
    await recordAiUsageEvent(env, { ...base, costUsd: 5.0, installationId: "101" });

    expect(await sumTenantAiComputeUnitsSince(env, [], "2020-01-01T00:00:00.000Z")).toBe(0);
  });
});
