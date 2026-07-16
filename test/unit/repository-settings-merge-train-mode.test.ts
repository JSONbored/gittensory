import { describe, expect, it } from "vitest";
import { getRepositorySettings } from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { resolveRepositorySettings } from "../../src/settings/repository-settings";
import { createTestEnv } from "../helpers/d1";

describe("mergeTrainMode config-as-code (#selfhost-merge-train, #6443)", () => {
  it("getRepositorySettings returns off for a repo with no DB row at all", async () => {
    const env = createTestEnv();
    const settings = await getRepositorySettings(env, "acme/brand-new-repo");
    expect(settings.mergeTrainMode).toBe("off");
  });

  it("resolves an explicit mergeTrainMode from the focus manifest", async () => {
    const env = createTestEnv();
    await upsertRepoFocusManifest(env, "acme/fresh-insert", { settings: { mergeTrainMode: "enforce" } });
    const settings = await resolveRepositorySettings(env, "acme/fresh-insert");
    expect(settings.mergeTrainMode).toBe("enforce");
  });

  it("keeps the raw database value at its built-in default", async () => {
    const env = createTestEnv();
    await upsertRepoFocusManifest(env, "acme/manifest-configured", { settings: { mergeTrainMode: "audit" } });
    const rawSettings = await getRepositorySettings(env, "acme/manifest-configured");
    expect(rawSettings.mergeTrainMode).toBe("off");
  });
});
