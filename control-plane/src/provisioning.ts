// provisionTenant / deprovisionTenant orchestration (#7524) over the injectable `TenantProvisioningDriver`.
// Product-agnostic: an ORB tenant and an AMS tenant take the identical call shape — `product` is forwarded to
// every driver step but never branched on. Provision runs #7180's three steps in order (create-container,
// provision-DB, inject-secrets); deprovision tears them down in REVERSE (revoke-secrets, drop-DB,
// destroy-container) so a secret is never left addressable after the DB/container it belonged to is gone.
//
// #7667: a driver-step failure in EITHER direction also pages, via the same PagerDuty Events API v2 contract
// ORB uses in `src/services/notify-pagerduty.ts` (see ./pagerduty-notify.ts for the mirrored contract and why
// this package can't import that Worker/D1-bound module directly). A provisioning failure during a real pilot
// must page a human, not fail silently — the original error is always rethrown after paging so callers keep
// seeing the real failure; paging is additive, never a substitute for surfacing the error.

import {
  buildProvisioningPagerDutyAlert,
  notifyProvisioningFailure,
  pagerDutyFailMessage,
  type NotifyProvisioningFailure,
} from "./pagerduty-notify.js";
import type {
  DatabaseConnectionDetails,
  Product,
  Tenant,
  TenantLifecycleState,
  TenantProvisioningDriver,
  TenantProvisioningRequest,
} from "./tenant-provisioning-driver.js";

/** Result of a successful provision — terminal lifecycle state `"active"` (the vocabulary tenant-client.ts
 *  passes through from this API). Carries `database` (#7653) so a freshly created role's connection details --
 *  often retrievable from the provider only at creation time -- aren't silently discarded by this orchestration
 *  before any caller gets a chance to persist them. Also carries `secretRef` (#8066) when the configured driver
 *  returned one from `injectSecrets` -- an opaque reference a caller (e.g. http-app.ts's tenant registry) must
 *  persist so a later `deprovisionTenant` can thread it back in for `revokeSecrets`; absent when the composed
 *  driver has nothing to track (e.g. the fake, or before a real secret driver is configured). */
export type TenantProvisioningResult = {
  tenant: Tenant;
  product: Product;
  state: Extract<TenantLifecycleState, "active">;
  database: DatabaseConnectionDetails;
  secretRef?: string;
};

/** Result of a successful deprovision — terminal lifecycle state `"torn down"`. */
export type TenantDeprovisioningResult = {
  tenant: Tenant;
  product: Product;
  state: Extract<TenantLifecycleState, "torn down">;
};

/** Injectable PagerDuty seam shared by provisionTenant/deprovisionTenant (test-only override point; production
 *  callers omit both and get the real {@link notifyProvisioningFailure} against `process.env`). */
export type ProvisioningPagerDutyOptions = {
  notify?: NotifyProvisioningFailure;
  env?: Record<string, string | undefined>;
};

/** Page on a provisioning-lifecycle failure (#7667) and always rethrow. Fire-and-forget, same shape as #7666's
 *  miner-side mirror: the notify call is never awaited (a paging failure/slow network must not delay the
 *  caller from seeing its own real error), and both a sync throw and an async rejection from `notify` are
 *  funneled through one warn log so neither can escape as an unhandled rejection. */
function pageAndRethrow(
  tenant: Tenant,
  product: Product,
  phase: "provision" | "deprovision",
  error: unknown,
  options: ProvisioningPagerDutyOptions,
): never {
  const alert = buildProvisioningPagerDutyAlert({ tenantName: tenant.name, product, phase, error });
  const notify = options.notify ?? notifyProvisioningFailure;
  const env = options.env ?? process.env;
  const warnNotifyFailed = (notifyError: unknown): void => {
    console.warn(
      JSON.stringify({ event: "provisioning_pagerduty_failed", tenant: tenant.name, message: pagerDutyFailMessage(notifyError) }),
    );
  };
  try {
    void Promise.resolve(notify(alert, env)).catch(warnNotifyFailed);
  } catch (notifyError) {
    warnNotifyFailed(notifyError);
  }
  throw error;
}

/** Provision a tenant by running #7180's three steps in order against the injected driver. Product-agnostic:
 *  `product` is forwarded to every step, never branched on, so ORB and AMS share one call shape. `injectSecrets`
 *  is called with `database` already attached to the request (#8066) -- a real secret driver needs the
 *  connection details to actually store, not just the tenant identity every other step operates on. A step
 *  failure pages (#7667) and always rethrows — provisioning never fails silently. */
export async function provisionTenant(
  tenant: Tenant,
  product: Product,
  driver: TenantProvisioningDriver,
  pagerDuty: ProvisioningPagerDutyOptions = {},
): Promise<TenantProvisioningResult> {
  const request: TenantProvisioningRequest = { tenant, product };
  let database: DatabaseConnectionDetails;
  let secretRef: string | undefined;
  try {
    await driver.createContainer(request);
    database = await driver.provisionDatabase(request);
    ({ secretRef } = await driver.injectSecrets({ ...request, database }));
  } catch (error) {
    pageAndRethrow(tenant, product, "provision", error, pagerDuty);
  }
  return { tenant, product, state: "active", database, ...(secretRef !== undefined ? { secretRef } : {}) };
}

/** Deprovision a tenant by tearing #7180's three steps down in REVERSE order. Same product-agnostic call shape
 *  as provisionTenant. `secretRef` (#8066, optional -- a caller with no real secret driver configured, or a
 *  tenant provisioned before one was, has none to pass) is attached to the request so `revokeSecrets` knows
 *  what to revoke; omitted entirely, it's the same as the pre-#8066 behavior. Idempotent by driver contract:
 *  deprovisioning a tenant that was never provisioned is a safe no-op, never a throw. A step failure pages
 *  (#7667) and always rethrows. */
export async function deprovisionTenant(
  tenant: Tenant,
  product: Product,
  driver: TenantProvisioningDriver,
  pagerDuty: ProvisioningPagerDutyOptions = {},
  secretRef?: string,
): Promise<TenantDeprovisioningResult> {
  const request: TenantProvisioningRequest = { tenant, product, ...(secretRef !== undefined ? { secretRef } : {}) };
  try {
    await driver.revokeSecrets(request);
    await driver.dropDatabase(request);
    await driver.destroyContainer(request);
  } catch (error) {
    pageAndRethrow(tenant, product, "deprovision", error, pagerDuty);
  }
  return { tenant, product, state: "torn down" };
}
