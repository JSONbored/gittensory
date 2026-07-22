import { afterEach, describe, expect, it, vi } from "vitest";
import { isPerRepoAdminModeEnabled, isPerTenantAdmin } from "../../src/auth/security";
import { createTestEnv } from "../helpers/d1";

// #4889: the hosted per-repo admin helpers. isPerTenantAdmin replaces bare ADMIN_GITHUB_LOGINS membership at
// the review/queue exemption sites: mode OFF (self-host default) must stay byte-identical allowlist
// membership; mode ON swaps in GitHub's real-time collaborator permission and fails CLOSED on every
// can't-verify path (no installation, API error, unknown collaborator) — an API blip must never grant
// fleet-operator trust.

afterEach(() => vi.unstubAllGlobals());

describe("isPerRepoAdminModeEnabled (#4889)", () => {
  it("accepts the standard truthy spellings, case-insensitively, with whitespace", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on", " on "]) {
      expect(isPerRepoAdminModeEnabled({ LOOPOVER_PER_REPO_ADMIN: value })).toBe(true);
    }
  });

  it("is OFF for unset, empty, and non-truthy values — self-host default", () => {
    for (const value of [undefined, "", "false", "0", "off", "enabled"]) {
      expect(isPerRepoAdminModeEnabled({ LOOPOVER_PER_REPO_ADMIN: value })).toBe(false);
    }
  });
});

describe("isPerTenantAdmin (#4889)", () => {
  const REPO = "acme/widgets";

  it("mode OFF: exact ADMIN_GITHUB_LOGINS membership, case-insensitive, no permission lookup", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "FleetOp, other-admin" });
    const getPermission = vi.fn();
    expect(await isPerTenantAdmin(env, 42, REPO, "fleetop", getPermission)).toBe(true);
    expect(await isPerTenantAdmin(env, 42, REPO, " FleetOp ", getPermission)).toBe(true);
    expect(await isPerTenantAdmin(env, 42, REPO, "stranger", getPermission)).toBe(false);
    // A null installation doesn't matter in allowlist mode — no API is ever consulted.
    expect(await isPerTenantAdmin(env, null, REPO, "fleetop", getPermission)).toBe(true);
    expect(getPermission).not.toHaveBeenCalled();
  });

  it("mode ON: admin and maintain pass; write, read, and unknown deny — allowlist membership no longer grants", async () => {
    const env = createTestEnv({ ADMIN_GITHUB_LOGINS: "fleetop", LOOPOVER_PER_REPO_ADMIN: "true" });
    for (const [permission, expected] of [
      ["admin", true],
      ["maintain", true],
      ["write", false],
      ["read", false],
      [null, false],
    ] as const) {
      const getPermission = vi.fn().mockResolvedValue(permission);
      expect(await isPerTenantAdmin(env, 42, REPO, "FleetOp", getPermission)).toBe(expected);
      expect(getPermission).toHaveBeenCalledWith(env, 42, REPO, "fleetop");
    }
  });

  it("mode ON: fails closed when there is no installation to ask through", async () => {
    const env = createTestEnv({ LOOPOVER_PER_REPO_ADMIN: "true" });
    const getPermission = vi.fn();
    expect(await isPerTenantAdmin(env, null, REPO, "someone", getPermission)).toBe(false);
    expect(getPermission).not.toHaveBeenCalled();
  });

  it("mode ON: fails closed (and logs) when the permission lookup throws — Error and non-Error alike", async () => {
    const env = createTestEnv({ LOOPOVER_PER_REPO_ADMIN: "true" });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await isPerTenantAdmin(env, 42, REPO, "someone", vi.fn().mockRejectedValue(new Error("github down")))).toBe(false);
    expect(await isPerTenantAdmin(env, 42, REPO, "someone", vi.fn().mockRejectedValue("string-throw"))).toBe(false);
    const events = log.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(events).toHaveLength(2);
    for (const event of events) expect(event).toMatchObject({ event: "per_tenant_admin_check_failed", repoFullName: REPO, login: "someone" });
    expect(events[0]!.message).toBe("github down");
    log.mockRestore();
  });

  it("denies a blank login in either mode without any lookup", async () => {
    const getPermission = vi.fn();
    expect(await isPerTenantAdmin(createTestEnv({ ADMIN_GITHUB_LOGINS: "fleetop" }), 42, REPO, "  ", getPermission)).toBe(false);
    expect(await isPerTenantAdmin(createTestEnv({ LOOPOVER_PER_REPO_ADMIN: "true" }), 42, REPO, "", getPermission)).toBe(false);
    expect(getPermission).not.toHaveBeenCalled();
  });

  it("mode ON without an injected fetcher uses the real permission lookup, still failing closed on error", async () => {
    const env = createTestEnv({ LOOPOVER_PER_REPO_ADMIN: "true" });
    // The real getRepositoryCollaboratorPermission path starts with an installation-token exchange; a stubbed
    // global fetch that refuses everything proves the default path is wired AND that its failure denies.
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await isPerTenantAdmin(env, 42, REPO, "someone")).toBe(false);
    log.mockRestore();
  });
});
