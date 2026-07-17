import { describe, expect, it } from "vitest";
import { getRepositorySettings, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

// #selfhost-linked-issue-gate-drift/#6444: repository_settings.linked_issue_gate_mode was persisted as
// 'block' in production for repos that never explicitly opted into it
// (migrations/0102_fix_linked_issue_gate_mode_default.sql backfills the historically-drifted rows). The
// column itself was dropped entirely in Batch C (loopover#6444) -- linkedIssueGateMode is config-as-code
// only now, so getRepositorySettings/upsertRepositorySettings always return the hardcoded "advisory"
// default regardless of caller input; resolveEffectiveSettings (not this DB layer) overlays a repo's
// .loopover.yml gate.linkedIssue value on top. The explicit-opt-in/round-trip tests this file used to
// carry no longer apply once there is no column left to round-trip through.
describe("repository_settings: linked-issue gate defaults to advisory, not block (#selfhost-linked-issue-gate-drift)", () => {
  it("getRepositorySettings returns advisory for a repo with no DB row at all", async () => {
    const env = createTestEnv();
    const settings = await getRepositorySettings(env, "acme/brand-new-repo");
    expect(settings.linkedIssueGateMode).toBe("advisory");
    expect(settings.requireLinkedIssue).toBe(false);
  });

  it("upsertRepositorySettings ignores any caller-supplied linkedIssueGateMode -- the read-back is always the hardcoded default", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "acme/omits-gate-mode", linkedIssueGateMode: "block" });
    const settings = await getRepositorySettings(env, "acme/omits-gate-mode");
    expect(settings.linkedIssueGateMode).toBe("advisory");
  });
});
