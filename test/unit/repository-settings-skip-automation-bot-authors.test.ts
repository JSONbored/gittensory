import { describe, expect, it } from "vitest";
import { getRepositorySettings, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #automation-bot-skip: skipAutomationBotAuthors ("inherit" | "off" | "enabled") mirrors moderationGateMode's
// shape (migrations/0105) -- see repository-settings-merge-train-mode.test.ts's own comment for the exact
// INSERT/UPDATE persistence bug this pattern guards against.
describe("repository_settings: skipAutomationBotAuthors persistence (#automation-bot-skip)", () => {
  it("getRepositorySettings returns inherit for a repo with no DB row at all (defers to the global default)", async () => {
    const env = createTestEnv();
    const settings = await getRepositorySettings(env, "acme/brand-new-repo");
    expect(settings.skipAutomationBotAuthors).toBe("inherit");
  });

  it("an explicit skipAutomationBotAuthors persists on the FIRST upsert (INSERT path)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/fresh-insert", skipAutomationBotAuthors: "enabled" });
    const settings = await getRepositorySettings(env, "acme/fresh-insert");
    expect(settings.skipAutomationBotAuthors).toBe("enabled");
  });

  it("an explicit skipAutomationBotAuthors persists on a SECOND upsert of an already-existing row (UPDATE path)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/existing-row" });
    const before = await getRepositorySettings(env, "acme/existing-row");
    expect(before.skipAutomationBotAuthors).toBe("inherit");

    await upsertRepositorySettings(env, { repoFullName: "acme/existing-row", skipAutomationBotAuthors: "off" });
    const after = await getRepositorySettings(env, "acme/existing-row");
    expect(after.skipAutomationBotAuthors).toBe("off");
  });

  it("a true read-modify-write caller (spread current settings, then re-upsert) carries skipAutomationBotAuthors forward explicitly", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/round-trip", skipAutomationBotAuthors: "enabled" });
    const settings = await getRepositorySettings(env, "acme/round-trip");
    expect(settings.skipAutomationBotAuthors).toBe("enabled");
    await upsertRepositorySettings(env, { ...settings, repoFullName: "acme/round-trip" });
    const after = await getRepositorySettings(env, "acme/round-trip");
    expect(after.skipAutomationBotAuthors).toBe("enabled");
  });

  it("an invalid persisted DB value fails closed to inherit on read", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/malformed" });
    await env.DB.prepare("UPDATE repository_settings SET skip_automation_bot_authors = ? WHERE repo_full_name = ?").bind("sometimes", "acme/malformed").run();
    const settings = await getRepositorySettings(env, "acme/malformed");
    expect(settings.skipAutomationBotAuthors).toBe("inherit");
  });
});
