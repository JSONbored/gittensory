// Tests for #7667's PagerDuty wiring into provisionTenant/deprovisionTenant: a driver-step failure in either
// direction pages via the injected `notify` hook AND always rethrows the original error (paging is additive,
// never a substitute for surfacing the failure); a successful lifecycle never pages.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFakeTenantProvisioningDriver,
  deprovisionTenant,
  provisionTenant,
  type NotifyProvisioningFailure,
  type ProvisioningPagerDutyAlert,
  type Tenant,
  type TenantProvisioningDriver,
  type TenantProvisioningRequest,
} from "../dist/index.js";

/** A driver where exactly one named step throws `error`; every other step is a no-op success. */
function driverThatThrowsOn(
  step: keyof Omit<TenantProvisioningDriver, "containerExists">,
  error: Error,
): TenantProvisioningDriver {
  const noop = async (): Promise<void> => {};
  const failing = async (): Promise<never> => {
    throw error;
  };
  // #8202: injectSecrets' real return type is destructured by provisionTenant (secretRef, bootstrapSecret), so
  // its own "successfully did nothing" stand-in must return a real (empty) object, not void -- unlike every
  // other step here, which provisionTenant/deprovisionTenant only ever await, never read a value from.
  const noopInjectSecrets = async (): Promise<{ secretRef?: string; bootstrapSecret?: string }> => ({});
  return {
    createContainer: step === "createContainer" ? failing : noop,
    provisionDatabase: step === "provisionDatabase" ? failing : noop,
    injectSecrets: step === "injectSecrets" ? failing : noopInjectSecrets,
    destroyContainer: step === "destroyContainer" ? failing : noop,
    dropDatabase: step === "dropDatabase" ? failing : noop,
    revokeSecrets: step === "revokeSecrets" ? failing : noop,
    containerExists: async () => false,
  };
}

test("provisionTenant pages PagerDuty and rethrows when a driver step fails (#7667)", async () => {
  const calls: ProvisioningPagerDutyAlert[] = [];
  const notify: NotifyProvisioningFailure = async (alert) => {
    calls.push(alert);
  };
  const driver = driverThatThrowsOn("provisionDatabase", new Error("db provisioning failed"));
  const tenant: Tenant = { name: "acme" };

  await assert.rejects(provisionTenant(tenant, "orb", driver, { notify }), /db provisioning failed/);
  // The page is fire-and-forget; flush the microtask queue before asserting it landed.
  await Promise.resolve();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.phase, "provision");
  assert.equal(calls[0]?.tenantName, "acme");
  assert.equal(calls[0]?.product, "orb");
  assert.equal(calls[0]?.dedupKey, "control_plane_provision_failed:orb:acme");
});

test("provisionTenant does NOT page PagerDuty on a successful provision (#7667)", async () => {
  const calls: ProvisioningPagerDutyAlert[] = [];
  const notify: NotifyProvisioningFailure = async (alert) => {
    calls.push(alert);
  };
  const driver = createFakeTenantProvisioningDriver();
  const tenant: Tenant = { name: "acme" };

  const result = await provisionTenant(tenant, "orb", driver, { notify });

  assert.deepEqual(result, {
    tenant,
    product: "orb",
    state: "active",
    database: {
      host: "fake-acme.control-plane.invalid",
      port: 5432,
      database: "acme",
      user: "acme",
      password: "fake-password-acme",
      connectionString: "postgres://acme:fake-password-acme@fake-acme.control-plane.invalid:5432/acme",
    },
  });
  assert.equal(calls.length, 0);
});

test("deprovisionTenant pages PagerDuty and rethrows when a driver step fails (#7667)", async () => {
  const calls: ProvisioningPagerDutyAlert[] = [];
  const notify: NotifyProvisioningFailure = async (alert) => {
    calls.push(alert);
  };
  const driver = driverThatThrowsOn("revokeSecrets", new Error("secret broker unreachable"));
  const tenant: Tenant = { name: "acme" };

  await assert.rejects(deprovisionTenant(tenant, "ams", driver, { notify }), /secret broker unreachable/);
  await Promise.resolve();

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.phase, "deprovision");
  assert.equal(calls[0]?.product, "ams");
  assert.equal(calls[0]?.dedupKey, "control_plane_deprovision_failed:ams:acme");
});

test("deprovisionTenant does NOT page PagerDuty on a successful deprovision (#7667)", async () => {
  const calls: ProvisioningPagerDutyAlert[] = [];
  const notify: NotifyProvisioningFailure = async (alert) => {
    calls.push(alert);
  };
  const driver = createFakeTenantProvisioningDriver();
  const tenant: Tenant = { name: "acme" };

  const result = await deprovisionTenant(tenant, "ams", driver, { notify });

  assert.deepEqual(result, { tenant, product: "ams", state: "torn down" });
  assert.equal(calls.length, 0);
});

test("provisionTenant still rethrows the real error when the notify hook itself throws synchronously (#7667)", async () => {
  const driver = driverThatThrowsOn("createContainer", new Error("container quota exceeded"));
  const tenant: Tenant = { name: "acme" };
  const notify: NotifyProvisioningFailure = () => {
    throw new Error("pagerduty transport down");
  };

  await assert.rejects(provisionTenant(tenant, "orb", driver, { notify }), /container quota exceeded/);
});

test("provisionTenant still rethrows the real error when the notify hook rejects asynchronously (#7667)", async () => {
  const driver = driverThatThrowsOn("injectSecrets", new Error("secret injection failed"));
  const tenant: Tenant = { name: "acme" };
  const notify: NotifyProvisioningFailure = async () => {
    throw new Error("pagerduty http 500");
  };

  await assert.rejects(provisionTenant(tenant, "orb", driver, { notify }), /secret injection failed/);
  // Let the fire-and-forget rejection's own .catch handler run so it never surfaces as unhandled.
  await Promise.resolve();
  await Promise.resolve();
});

test("provisionTenant defaults to the real notifyProvisioningFailure + process.env when no PagerDuty options are passed (#7667)", async () => {
  const driver = driverThatThrowsOn("createContainer", new Error("container quota exceeded"));
  const tenant: Tenant = { name: "acme" };

  // LOOPOVER_ENABLE_PAGERDUTY is unset in the test environment, so the real default notify path resolves to a
  // no-op -- this exercises the "no options passed" default-parameter branch itself; the live network call's
  // own guard branches are covered in pagerduty-notify.test.ts.
  await assert.rejects(provisionTenant(tenant, "orb", driver), /container quota exceeded/);
});

test("deprovisionTenant defaults to the real notifyProvisioningFailure + process.env when no PagerDuty options are passed (#7667)", async () => {
  const driver = driverThatThrowsOn("dropDatabase", new Error("db drop failed"));
  const tenant: Tenant = { name: "acme" };

  await assert.rejects(deprovisionTenant(tenant, "ams", driver), /db drop failed/);
});

// #8202: injectSecrets moved ahead of createContainer, so secretRef can now be minted and THEN orphaned if
// createContainer fails right after -- provisionTenant always rethrows rather than returning, so no caller ever
// gets secretRef to persist and revoke later otherwise. These prove the fix: a best-effort self-revoke, safe
// even when that revoke itself fails, and correctly scoped to only fire once a real secretRef actually exists.

test("#8202: provisionTenant best-effort revokes the just-injected secret when createContainer fails right after, before rethrowing", async () => {
  const revokeCalls: TenantProvisioningRequest[] = [];
  const driver: TenantProvisioningDriver = {
    ...createFakeTenantProvisioningDriver(),
    injectSecrets: async () => ({ secretRef: "orbenr_abc", bootstrapSecret: "orbsec_xyz" }),
    createContainer: async () => {
      throw new Error("container quota exceeded");
    },
    revokeSecrets: async (request) => {
      revokeCalls.push(request);
    },
  };
  const tenant: Tenant = { name: "acme" };

  await assert.rejects(provisionTenant(tenant, "orb", driver), /container quota exceeded/);

  assert.equal(revokeCalls.length, 1);
  assert.equal(revokeCalls[0]?.secretRef, "orbenr_abc");
});

test("#8202: a failure in the best-effort revoke itself does not mask the real createContainer error", async () => {
  const driver: TenantProvisioningDriver = {
    ...createFakeTenantProvisioningDriver(),
    injectSecrets: async () => ({ secretRef: "orbenr_abc" }),
    createContainer: async () => {
      throw new Error("container quota exceeded");
    },
    revokeSecrets: async () => {
      throw new Error("broker unreachable");
    },
  };
  const tenant: Tenant = { name: "acme" };

  await assert.rejects(provisionTenant(tenant, "orb", driver), /container quota exceeded/);
});

test("#8202: provisionTenant does NOT attempt a revoke when no secretRef was ever obtained (e.g. provisionDatabase itself failed)", async () => {
  const revokeCalls: TenantProvisioningRequest[] = [];
  const driver: TenantProvisioningDriver = {
    ...driverThatThrowsOn("provisionDatabase", new Error("db provisioning failed")),
    revokeSecrets: async (request) => {
      revokeCalls.push(request);
    },
  };
  const tenant: Tenant = { name: "acme" };

  await assert.rejects(provisionTenant(tenant, "orb", driver), /db provisioning failed/);

  assert.equal(revokeCalls.length, 0);
});

test("#8202: provisionTenant does NOT attempt a revoke when injectSecrets itself is the step that failed", async () => {
  const revokeCalls: TenantProvisioningRequest[] = [];
  const driver: TenantProvisioningDriver = {
    ...driverThatThrowsOn("injectSecrets", new Error("secret injection failed")),
    revokeSecrets: async (request) => {
      revokeCalls.push(request);
    },
  };
  const tenant: Tenant = { name: "acme" };

  await assert.rejects(provisionTenant(tenant, "orb", driver), /secret injection failed/);

  assert.equal(revokeCalls.length, 0);
});

test("#8202: the PagerDuty alert carries secretRef when injectSecrets had already succeeded before the failing step", async () => {
  const calls: ProvisioningPagerDutyAlert[] = [];
  const notify: NotifyProvisioningFailure = async (alert) => {
    calls.push(alert);
  };
  const driver: TenantProvisioningDriver = {
    ...createFakeTenantProvisioningDriver(),
    injectSecrets: async () => ({ secretRef: "orbenr_abc" }),
    createContainer: async () => {
      throw new Error("container quota exceeded");
    },
  };
  const tenant: Tenant = { name: "acme" };

  await assert.rejects(provisionTenant(tenant, "orb", driver, { notify }), /container quota exceeded/);
  await Promise.resolve();

  assert.equal(calls[0]?.customDetails.secretRef, "orbenr_abc");
});

test("#8202: the PagerDuty alert omits secretRef entirely when none was ever obtained", async () => {
  const calls: ProvisioningPagerDutyAlert[] = [];
  const notify: NotifyProvisioningFailure = async (alert) => {
    calls.push(alert);
  };
  const driver = driverThatThrowsOn("provisionDatabase", new Error("db provisioning failed"));
  const tenant: Tenant = { name: "acme" };

  await assert.rejects(provisionTenant(tenant, "orb", driver, { notify }), /db provisioning failed/);
  await Promise.resolve();

  assert.equal("secretRef" in (calls[0]?.customDetails ?? {}), false);
});

test("#8202: deprovisionTenant's PagerDuty alert carries the secretRef it was given, for operator convenience", async () => {
  const calls: ProvisioningPagerDutyAlert[] = [];
  const notify: NotifyProvisioningFailure = async (alert) => {
    calls.push(alert);
  };
  const driver = driverThatThrowsOn("dropDatabase", new Error("db drop failed"));
  const tenant: Tenant = { name: "acme" };

  await assert.rejects(deprovisionTenant(tenant, "ams", driver, { notify }, "orbenr_abc"), /db drop failed/);
  await Promise.resolve();

  assert.equal(calls[0]?.customDetails.secretRef, "orbenr_abc");
});
