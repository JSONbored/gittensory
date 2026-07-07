import { describe, expect, it } from "vitest";
import { getRepositorySettings, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #1961/#3906: linkedIssueSatisfactionGateMode is the DB-backed, dashboard-settable gate-mode counterpart to
// aiReviewMode/selfAuthoredLinkedIssueGateMode -- off (default, byte-identical) | advisory (renders, never
// blocks) | block (an above-confidence-floor "unaddressed" verdict becomes a hard blocker).
describe("repository_settings: linkedIssueSatisfactionGateMode default + round-trip (#1961/#3906)", () => {
  it("getRepositorySettings returns off for a repo with no DB row at all (conservative, opt-in default)", async () => {
    const env = createTestEnv();
    const settings = await getRepositorySettings(env, "acme/brand-new-repo");
    expect(settings.linkedIssueSatisfactionGateMode).toBe("off");
  });

  it("upsertRepositorySettings persists off when the caller omits the field entirely", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/omits-field" });
    const settings = await getRepositorySettings(env, "acme/omits-field");
    expect(settings.linkedIssueSatisfactionGateMode).toBe("off");
  });

  it("an explicit advisory/block opt-in round-trips through a re-upsert that carries it forward explicitly", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/round-trip", linkedIssueSatisfactionGateMode: "advisory" });
    const settings = await getRepositorySettings(env, "acme/round-trip");
    expect(settings.linkedIssueSatisfactionGateMode).toBe("advisory");
    // A true read-modify-write caller (the route-handler pattern: spread current settings, then override) must
    // carry the persisted value forward explicitly -- upsertRepositorySettings never merges against the DB row.
    await upsertRepositorySettings(env, { ...settings, repoFullName: "acme/round-trip" });
    const after = await getRepositorySettings(env, "acme/round-trip");
    expect(after.linkedIssueSatisfactionGateMode).toBe("advisory");
  });

  it("block round-trips distinctly from advisory, including through an UPDATE (onConflictDoUpdate) of an existing row", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/block-mode", linkedIssueSatisfactionGateMode: "advisory" });
    await upsertRepositorySettings(env, { repoFullName: "acme/block-mode", linkedIssueSatisfactionGateMode: "block" });
    const settings = await getRepositorySettings(env, "acme/block-mode");
    expect(settings.linkedIssueSatisfactionGateMode).toBe("block");
  });

  it("an invalid persisted DB value fails closed to advisory on read (parseGateRuleMode's shared fallback)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/malformed" });
    await env.DB.prepare("UPDATE repository_settings SET linked_issue_satisfaction_gate_mode = ? WHERE repo_full_name = ?").bind("sometimes", "acme/malformed").run();
    const settings = await getRepositorySettings(env, "acme/malformed");
    expect(settings.linkedIssueSatisfactionGateMode).toBe("advisory");
  });
});
