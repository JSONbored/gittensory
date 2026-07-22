// Contract tests for the in-memory fake driver — the maps toggle with create/destroy, and both the
// destroy-of-an-existing and destroy-of-a-nonexistent (idempotent no-op) branches are exercised.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFakeTenantProvisioningDriver,
  type TenantProvisioningRequest,
} from "../dist/index.js";

const requestFor = (
  name: string,
  product: string,
): TenantProvisioningRequest => ({
  tenant: { name },
  product,
});

test("createContainer makes the tenant's container exist; destroyContainer removes it", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const request = requestFor("acme", "orb");

  assert.equal(await driver.containerExists(request), false);
  await driver.createContainer(request);
  assert.equal(await driver.containerExists(request), true);
  assert.ok(driver.containers.has("orb:acme"));

  await driver.destroyContainer(request);
  assert.equal(await driver.containerExists(request), false);
  assert.equal(driver.containers.has("orb:acme"), false);
});

test("destroyContainer on a never-created container is an idempotent no-op", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const request = requestFor("ghost", "ams");

  // else-branch: nothing to remove — must not throw.
  await driver.destroyContainer(request);
  assert.equal(await driver.containerExists(request), false);
  assert.equal(driver.containers.has("ams:ghost"), false);
});

test("provisionDatabase returns deterministic per-tenant connection details (#7653)", async () => {
  const driver = createFakeTenantProvisioningDriver();

  const details = await driver.provisionDatabase(requestFor("acme", "orb"));

  assert.deepEqual(details, {
    host: "fake-acme.control-plane.invalid",
    port: 5432,
    database: "acme",
    user: "acme",
    password: "fake-password-acme",
    connectionString: "postgres://acme:fake-password-acme@fake-acme.control-plane.invalid:5432/acme",
  });
});

test("provision/teardown steps toggle the database and secret maps too", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const request = requestFor("acme", "ams");

  await driver.provisionDatabase(request);
  await driver.injectSecrets(request);
  assert.ok(driver.databases.has("ams:acme"));
  assert.ok(driver.injectedSecrets.has("ams:acme"));

  await driver.dropDatabase(request);
  await driver.revokeSecrets(request);
  assert.equal(driver.databases.has("ams:acme"), false);
  assert.equal(driver.injectedSecrets.has("ams:acme"), false);
});

test("dropDatabase / revokeSecrets on a never-provisioned tenant are idempotent no-ops", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const request = requestFor("ghost", "orb");

  await driver.dropDatabase(request);
  await driver.revokeSecrets(request);
  assert.equal(driver.databases.has("orb:ghost"), false);
  assert.equal(driver.injectedSecrets.has("orb:ghost"), false);
});

test("the fake records every step it runs, in call order, with its tenant and product", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const request = requestFor("acme", "orb");

  await driver.createContainer(request);
  await driver.injectSecrets(request);

  assert.deepEqual(
    driver.calls.map((call) => call.step),
    ["createContainer", "injectSecrets"],
  );
  assert.deepEqual(driver.calls[0]?.tenant, { name: "acme" });
  assert.equal(driver.calls[0]?.product, "orb");
});

// Mirrors container-driver.test.ts's "the instance key is product-scoped..." — same name across products
// must not share fake-driver state on one shared driver (production's composition shape; #8025).
test("state maps are product-scoped (${product}:${tenant.name}), not just the tenant name", async () => {
  const driver = createFakeTenantProvisioningDriver();
  const orb = requestFor("acme", "orb");
  const ams = requestFor("acme", "ams");

  await driver.createContainer(orb);
  await driver.provisionDatabase(orb);
  await driver.injectSecrets(orb);
  await driver.createContainer(ams);
  await driver.provisionDatabase(ams);
  await driver.injectSecrets(ams);

  assert.ok(driver.containers.has("orb:acme"));
  assert.ok(driver.containers.has("ams:acme"));
  assert.ok(driver.injectedSecrets.has("orb:acme"));
  assert.ok(driver.injectedSecrets.has("ams:acme"));

  await driver.revokeSecrets(orb);
  assert.equal(driver.injectedSecrets.has("orb:acme"), false);
  assert.ok(driver.injectedSecrets.has("ams:acme"));

  await driver.destroyContainer(orb);
  await driver.dropDatabase(orb);
  assert.equal(await driver.containerExists(orb), false);
  assert.equal(await driver.containerExists(ams), true);
  assert.ok(driver.databases.has("ams:acme"));
  assert.equal(driver.databases.has("orb:acme"), false);
});
