import { describe, expect, it } from "vitest";
import { getRepositorySettings, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #2852/#5373: reviewCheckMode is the sole runtime authority for the "Gittensory Orb Review Agent" check-run
// publish decision (required/visible/disabled). A prior gateCheckMode (off/enabled) field was a deprecated
// computed read-back of reviewCheckMode with no effect as a write input; it has since been removed from
// RepositorySettings entirely (#5373) -- passing it to upsertRepositorySettings is now a compile-time error,
// not just a runtime no-op, so the tests that used to prove "gateCheckMode is ignored as a write input" no
// longer apply (the type system enforces it more strongly than a runtime assertion ever could). The legacy
// yml settings.gateCheckMode -> reviewCheckMode dual-write sync still exists one layer up, at
// packages/loopover-engine/src/focus-manifest.ts's parse step (tracked separately for removal).
describe("repository_settings: reviewCheckMode default (#2852)", () => {
  it("getRepositorySettings returns disabled for a repo with no DB row at all (conservative, opt-in default)", async () => {
    const env = createTestEnv();
    const settings = await getRepositorySettings(env, "acme/brand-new-repo");
    expect(settings.reviewCheckMode).toBe("disabled");
  });

  it("upsertRepositorySettings persists disabled when the caller omits reviewCheckMode entirely", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/omits-both" });
    const settings = await getRepositorySettings(env, "acme/omits-both");
    expect(settings.reviewCheckMode).toBe("disabled");
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
