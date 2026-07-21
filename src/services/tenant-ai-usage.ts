import { sumAiCostForTenantSince } from "../db/repositories";

// #7660: tenant-facing AI usage/spend. sumAiCostForTenantSince (src/db/repositories.ts, #7176) has
// computed a hosted tenant's raw AI cost since #7176 shipped, but nothing outside its own test file ever
// called it -- its fleet-wide sibling listAiCostByTenantSince is consumed only by the operator dashboard
// (src/services/operator-dashboard.ts), gated to the operator role, so no ORB/AMS hosted tenant could see
// their own usage/spend anywhere. This module converts that raw USD figure into the normalized
// compute-unit representation packages/loopover-engine/src/tenant-quota.ts's TenantQuota.computeUnits
// already uses, so a tenant is shown the same unit their allocation is budgeted in -- never the raw
// fractional-dollar costUsd. The route wiring lives in src/api/routes.ts ("/v1/app/tenant-ai-usage"),
// scoped the SAME WAY /v1/app/maintainer-dashboard already scopes its data (loadControlPanelAccessScope).

// 1 compute unit = $0.01 (one USD cent). An integer figure that still tracks spend proportionally
// without echoing a fractional-dollar cost back to the tenant.
const USD_PER_COMPUTE_UNIT = 0.01;

/**
 * Normalize a raw USD cost figure into a non-negative integer compute-unit count. A non-finite or
 * negative cost (never expected from sumAiCostForTenantSince's own SQL `coalesce(sum(...), 0)`, but not
 * trusted blindly here either) can never yield a NaN/negative unit count. Mirrors
 * packages/loopover-engine/src/tenant-quota.ts's own finiteNonNegativeInt normalization discipline; that
 * package has no dependency on the hosted src/ tree, so the rule is intentionally duplicated here rather
 * than shared.
 */
export function costUsdToComputeUnits(costUsd: number): number {
  return Number.isFinite(costUsd) ? Math.max(0, Math.floor(costUsd / USD_PER_COMPUTE_UNIT)) : 0;
}

/**
 * Sum one or more tenants' (installation ids') AI cost since `sinceIso`, converted to compute-units.
 * Called once per installation id in the caller's scope -- for a typical hosted tenant with exactly one
 * GitHub App installation this is a single query, mirroring sumAiCostForTenantSince's own
 * single-tenant contract; a caller in scope of several installations (e.g. an operator, or an owner with
 * more than one installed account) still gets one honest combined total rather than N separate figures
 * to reconcile themselves. An empty installationIds list sums to 0, not an error -- the same "no rows"
 * default sumAiCostForTenantSince itself returns for a tenant with no usage yet.
 */
export async function sumTenantAiComputeUnitsSince(env: Env, installationIds: readonly number[], sinceIso: string): Promise<number> {
  const costsUsd = await Promise.all(installationIds.map((installationId) => sumAiCostForTenantSince(env, String(installationId), sinceIso)));
  const totalCostUsd = costsUsd.reduce((sum, cost) => sum + cost, 0);
  return costUsdToComputeUnits(totalCostUsd);
}
