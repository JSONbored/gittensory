import { describe, expect, it } from "vitest";
import { getRepositorySettings, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #selfhost-linked-issue-gate-drift: repository_settings.linked_issue_gate_mode was persisted as 'block' in
// production for repos that never explicitly opted into it (migrations/0102_fix_linked_issue_gate_mode_default.sql
// backfills the historically-drifted rows). These regression tests pin the two paths that must default to
// 'advisory' going forward: a brand-new row (no DB row yet) and an explicit upsert that omits the field.
describe("repository_settings: linked-issue gate defaults to advisory, not block (#selfhost-linked-issue-gate-drift)", () => {
  it("getRepositorySettings returns advisory for a repo with no DB row at all", async () => {
    const env = createTestEnv();
    const settings = await getRepositorySettings(env, "acme/brand-new-repo");
    expect(settings.linkedIssueGateMode).toBe("advisory");
    expect(settings.requireLinkedIssue).toBe(false);
  });

  it("upsertRepositorySettings persists advisory when the caller omits linkedIssueGateMode entirely", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/omits-gate-mode" });
    const settings = await getRepositorySettings(env, "acme/omits-gate-mode");
    expect(settings.linkedIssueGateMode).toBe("advisory");
  });

  it("an explicit block opt-in is persisted and read back as block -- advisory-by-default does not clobber a real opt-in", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/explicit-block", linkedIssueGateMode: "block" });
    const settings = await getRepositorySettings(env, "acme/explicit-block");
    expect(settings.linkedIssueGateMode).toBe("block");
  });

  it("re-upserting without specifying linkedIssueGateMode keeps the row at its previously-set value (upsert defaults only apply when the field is omitted from the settings object, not merged against the existing row)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/round-trip", linkedIssueGateMode: "block" });
    const settings = await getRepositorySettings(env, "acme/round-trip");
    await upsertRepositorySettings(env, { ...settings, repoFullName: "acme/round-trip" });
    const after = await getRepositorySettings(env, "acme/round-trip");
    expect(after.linkedIssueGateMode).toBe("block");
  });
});
