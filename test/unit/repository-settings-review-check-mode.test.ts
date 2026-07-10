import { describe, expect, it } from "vitest";
import { getRepositorySettings, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #2852/#4618: reviewCheckMode is the sole runtime authority for the "Gittensory Orb Review Agent" check-run
// publish decision (required/visible/disabled). gateCheckMode (off/enabled) is deprecated: a computed
// read-back value only, derived from reviewCheckMode on every read, and it has NO effect as a write input to
// upsertRepositorySettings -- the legacy dual-write sync now lives only at the yml settings.gateCheckMode
// parse step (packages/gittensory-engine/src/focus-manifest.ts), not in the DB/API layer.
describe("repository_settings: reviewCheckMode default + gateCheckMode read-only derivation (#2852, #4618)", () => {
  it("getRepositorySettings returns disabled for a repo with no DB row at all (conservative, opt-in default)", async () => {
    const env = createTestEnv();
    const settings = await getRepositorySettings(env, "acme/brand-new-repo");
    expect(settings.reviewCheckMode).toBe("disabled");
    expect(settings.gateCheckMode).toBe("off");
  });

  it("upsertRepositorySettings persists disabled when the caller omits reviewCheckMode AND gateCheckMode entirely", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/omits-both" });
    const settings = await getRepositorySettings(env, "acme/omits-both");
    expect(settings.reviewCheckMode).toBe("disabled");
  });

  it("a caller that sets ONLY gateCheckMode: enabled (never touching reviewCheckMode) is ignored -- gateCheckMode is not a write input", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/legacy-enable", gateCheckMode: "enabled" });
    const settings = await getRepositorySettings(env, "acme/legacy-enable");
    expect(settings.reviewCheckMode).toBe("disabled");
    expect(settings.gateCheckMode).toBe("off"); // re-derived from reviewCheckMode, not the caller's stale input
  });

  it("a caller that sets ONLY gateCheckMode: off (never touching reviewCheckMode) stays disabled", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/legacy-disable", gateCheckMode: "off" });
    const settings = await getRepositorySettings(env, "acme/legacy-disable");
    expect(settings.reviewCheckMode).toBe("disabled");
  });

  it("reviewCheckMode is honored regardless of a gateCheckMode also passed in the same call (gateCheckMode is a no-op input)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/explicit-wins", gateCheckMode: "off", reviewCheckMode: "visible" });
    const settings = await getRepositorySettings(env, "acme/explicit-wins");
    expect(settings.reviewCheckMode).toBe("visible");
    expect(settings.gateCheckMode).toBe("enabled"); // derived from reviewCheckMode ("visible" !== "disabled"), not the "off" input
  });

  it("gateCheckMode self-heals on read even if a pre-#4618 row has a stale/divergent gate_check_mode column", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/stale-column", reviewCheckMode: "required" });
    await env.DB.prepare("UPDATE repository_settings SET gate_check_mode = ? WHERE repo_full_name = ?").bind("off", "acme/stale-column").run();
    const settings = await getRepositorySettings(env, "acme/stale-column");
    expect(settings.gateCheckMode).toBe("enabled"); // ignores the stale DB column, derives from reviewCheckMode
  });

  it("an explicit required/visible/disabled opt-in round-trips through a re-upsert that carries it forward explicitly", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/round-trip", reviewCheckMode: "visible" });
    const settings = await getRepositorySettings(env, "acme/round-trip");
    expect(settings.reviewCheckMode).toBe("visible");
    // A true read-modify-write caller (the route-handler pattern: spread current settings, then override) must
    // carry the persisted value forward explicitly -- upsertRepositorySettings never merges against the DB row.
    await upsertRepositorySettings(env, { ...settings, repoFullName: "acme/round-trip" });
    const after = await getRepositorySettings(env, "acme/round-trip");
    expect(after.reviewCheckMode).toBe("visible");
  });

  it("an invalid persisted DB value fails closed to disabled on read", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/malformed" });
    await env.DB.prepare("UPDATE repository_settings SET review_check_mode = ? WHERE repo_full_name = ?").bind("sometimes", "acme/malformed").run();
    const settings = await getRepositorySettings(env, "acme/malformed");
    expect(settings.reviewCheckMode).toBe("disabled");
  });
});
