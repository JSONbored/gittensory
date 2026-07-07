import { describe, expect, it } from "vitest";
import { getRepositorySettings, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #selfhost-merge-train: mergeTrainMode ("off" | "audit" | "enforce") was added to the schema/type/openapi
// layer but the INSERT and UPDATE column lists in upsertRepositorySettings never actually included it -- the
// resolved value was computed correctly but silently never written, so setting it via the settings API/
// dashboard (or any upsertRepositorySettings caller) was completely inert; the column stayed at its SQL
// DEFAULT 'off' forever, on both a brand-new row (INSERT) and an existing one (UPDATE via onConflictDoUpdate).
// Caught only by an integration-level merge-train test wired through the settings-resolution path, not by
// the pure decision function's own unit tests (merge-train.test.ts), which never touch the DB at all.
describe("repository_settings: mergeTrainMode persistence (#selfhost-merge-train)", () => {
  it("getRepositorySettings returns off for a repo with no DB row at all (conservative default)", async () => {
    const env = createTestEnv();
    const settings = await getRepositorySettings(env, "acme/brand-new-repo");
    expect(settings.mergeTrainMode).toBe("off");
  });

  it("REGRESSION: an explicit mergeTrainMode persists on the FIRST upsert (INSERT path)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/fresh-insert", mergeTrainMode: "enforce" });
    const settings = await getRepositorySettings(env, "acme/fresh-insert");
    expect(settings.mergeTrainMode).toBe("enforce");
  });

  it("REGRESSION: an explicit mergeTrainMode persists on a SECOND upsert of an already-existing row (UPDATE path)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/existing-row" });
    const before = await getRepositorySettings(env, "acme/existing-row");
    expect(before.mergeTrainMode).toBe("off");

    await upsertRepositorySettings(env, { repoFullName: "acme/existing-row", mergeTrainMode: "audit" });
    const after = await getRepositorySettings(env, "acme/existing-row");
    expect(after.mergeTrainMode).toBe("audit");
  });

  it("a true read-modify-write caller (spread current settings, then re-upsert) carries mergeTrainMode forward explicitly", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/round-trip", mergeTrainMode: "enforce" });
    const settings = await getRepositorySettings(env, "acme/round-trip");
    expect(settings.mergeTrainMode).toBe("enforce");
    await upsertRepositorySettings(env, { ...settings, repoFullName: "acme/round-trip" });
    const after = await getRepositorySettings(env, "acme/round-trip");
    expect(after.mergeTrainMode).toBe("enforce");
  });

  it("an invalid persisted DB value fails closed to off on read", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/malformed" });
    await env.DB.prepare("UPDATE repository_settings SET merge_train_mode = ? WHERE repo_full_name = ?").bind("sometimes", "acme/malformed").run();
    const settings = await getRepositorySettings(env, "acme/malformed");
    expect(settings.mergeTrainMode).toBe("off");
  });
});
