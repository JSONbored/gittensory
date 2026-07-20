import { describe, expect, it } from "vitest";
import {
  countModerationViolationsForActor,
  getGlobalModerationConfig,
  getRepositorySettings,
  hasModerationViolationForTarget,
  listModerationViolationsForActor,
  recordModerationViolation,
  upsertGlobalModerationConfig,
  upsertRepositorySettings,
} from "../../src/db/repositories";
import { resolveRepositorySettings } from "../../src/settings/repository-settings";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";
import { DEFAULT_REVIEW_EVASION_LABEL } from "../../src/settings/agent-actions";
import { DEFAULT_GLOBAL_MODERATION_CONFIG, MAX_MODERATION_VIOLATION_DECAY_DAYS, MODERATION_VIOLATION_EVENT_TYPE } from "../../src/settings/moderation-rules";

describe("global moderation config DB round-trip (#selfhost-mod-engine)", () => {
  it("defaults to the migrated singleton row's values (off, the original three rules) for a fresh install", async () => {
    const env = createTestEnv();
    // The migrated singleton row's rules_json literal predates review_evasion (#review-evasion-protection)
    // and is intentionally NOT auto-upgraded -- opting a NEW rule type into every existing install's shared
    // tally is an explicit config change, not a silent default. DEFAULT_GLOBAL_MODERATION_CONFIG.rules (the
    // MISSING-ROW fallback, asserted separately below) legitimately differs from this migrated default.
    expect(await getGlobalModerationConfig(env)).toEqual({ ...DEFAULT_GLOBAL_MODERATION_CONFIG, rules: ["contributor_cap", "blacklist", "review_nag"] });
  });

  it("returns the default when the singleton row is missing", async () => {
    const env = createTestEnv();
    await env.DB.prepare("DELETE FROM global_moderation_config WHERE id = 'singleton'").run();
    expect(await getGlobalModerationConfig(env)).toEqual(DEFAULT_GLOBAL_MODERATION_CONFIG);
  });

  it("fails open to the default when the table is unavailable", async () => {
    const env = createTestEnv();
    await env.DB.prepare("DROP TABLE global_moderation_config").run();
    expect(await getGlobalModerationConfig(env)).toEqual(DEFAULT_GLOBAL_MODERATION_CONFIG);
  });

  it("falls back to the default warning/banned label when the stored row has an empty/whitespace label (e.g. written directly via raw SQL, bypassing app-level upsert validation)", async () => {
    const env = createTestEnv();
    await env.DB.prepare("UPDATE global_moderation_config SET warning_label = '', banned_label = '   ' WHERE id = 'singleton'").run();
    const resolved = await getGlobalModerationConfig(env);
    expect(resolved.warningLabel).toBe(DEFAULT_GLOBAL_MODERATION_CONFIG.warningLabel);
    expect(resolved.bannedLabel).toBe(DEFAULT_GLOBAL_MODERATION_CONFIG.bannedLabel);
  });

  it("persists a full upsert and reads it back", async () => {
    const env = createTestEnv();
    const resolved = await upsertGlobalModerationConfig(env, {
      enabled: true,
      rules: ["blacklist", "review_nag"],
      warningLabel: "custom:warning",
      bannedLabel: "custom:banned",
      banThreshold: 3,
      violationDecayDays: 90,
      autoBlacklistOnBan: false,
      updatedBy: "JSONbored",
    });
    expect(resolved).toEqual({
      enabled: true,
      rules: ["blacklist", "review_nag"],
      warningLabel: "custom:warning",
      bannedLabel: "custom:banned",
      banThreshold: 3,
      violationDecayDays: 90,
      autoBlacklistOnBan: false,
    });
    expect(await getGlobalModerationConfig(env)).toEqual(resolved);
  });

  it("a PARTIAL upsert only changes the given fields, preserving the rest from the current row", async () => {
    const env = createTestEnv();
    await upsertGlobalModerationConfig(env, { enabled: true, banThreshold: 3 });
    const resolved = await upsertGlobalModerationConfig(env, { warningLabel: "mod:caution" });
    expect(resolved.enabled).toBe(true);
    expect(resolved.banThreshold).toBe(3);
    expect(resolved.warningLabel).toBe("mod:caution");
  });

  it("drops an invalid rule type on upsert with a fallback to a valid subset, and coerces a malformed threshold/label back to the current value", async () => {
    const env = createTestEnv();
    const invalidRules = ["blacklist", "not-a-rule"] as unknown as ("contributor_cap" | "blacklist" | "review_nag")[];
    const resolved = await upsertGlobalModerationConfig(env, { rules: invalidRules, banThreshold: -1, warningLabel: "   " });
    expect(resolved.rules).toEqual(["blacklist"]);
    // Malformed values fall back to the CURRENT row's value (this is the first write, so that's still the
    // module default), not silently to 0/empty.
    expect(resolved.banThreshold).toBe(DEFAULT_GLOBAL_MODERATION_CONFIG.banThreshold);
    expect(resolved.warningLabel).toBe(DEFAULT_GLOBAL_MODERATION_CONFIG.warningLabel);
  });

  it("REGRESSION (gate-flagged): violationDecayDays above MAX_MODERATION_VIOLATION_DECAY_DAYS is CLAMPED, not passed through raw -- an unbounded value overflows Date arithmetic on the live close path", async () => {
    const env = createTestEnv();
    const resolved = await upsertGlobalModerationConfig(env, { violationDecayDays: MAX_MODERATION_VIOLATION_DECAY_DAYS + 1_000_000 });
    expect(resolved.violationDecayDays).toBe(MAX_MODERATION_VIOLATION_DECAY_DAYS);
    expect(await getGlobalModerationConfig(env)).toEqual(resolved);
    // Confirms the clamp actually keeps Date arithmetic sane -- this would throw (RangeError: Invalid time
    // value) if the raw unclamped input were used instead.
    expect(() => new Date(Date.now() - resolved.violationDecayDays! * 24 * 60 * 60 * 1000).toISOString()).not.toThrow();
  });

  it("a violationDecayDays AT the max is preserved unclamped (boundary, not just strictly-under)", async () => {
    const env = createTestEnv();
    const resolved = await upsertGlobalModerationConfig(env, { violationDecayDays: MAX_MODERATION_VIOLATION_DECAY_DAYS });
    expect(resolved.violationDecayDays).toBe(MAX_MODERATION_VIOLATION_DECAY_DAYS);
  });

  it("a raw DB row with an over-max violation_decay_days is also clamped on READ (not just on write)", async () => {
    const env = createTestEnv();
    await env.DB.prepare("UPDATE global_moderation_config SET violation_decay_days = ? WHERE id = 'singleton'").bind(MAX_MODERATION_VIOLATION_DECAY_DAYS * 10).run();
    const resolved = await getGlobalModerationConfig(env);
    expect(resolved.violationDecayDays).toBe(MAX_MODERATION_VIOLATION_DECAY_DAYS);
  });
});

describe("moderation violation ledger (#selfhost-mod-engine)", () => {
  it("records a violation and counts it back for the actor", async () => {
    const env = createTestEnv();
    await recordModerationViolation(env, {
      eventType: MODERATION_VIOLATION_EVENT_TYPE.contributor_cap,
      actor: "farmer99",
      targetKey: "owner/repo#42",
      repoFullName: "owner/repo",
      ruleReason: "contributor_cap violation",
    });
    const count = await countModerationViolationsForActor(env, "farmer99", [MODERATION_VIOLATION_EVENT_TYPE.contributor_cap]);
    expect(count).toBe(1);
  });

  it("counts across MULTIPLE rule types and MULTIPLE repos for the same actor (install-wide, not per-repo)", async () => {
    const env = createTestEnv();
    await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.contributor_cap, actor: "farmer99", targetKey: "owner/repo-a#1", repoFullName: "owner/repo-a", ruleReason: "cap" });
    await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.blacklist, actor: "farmer99", targetKey: "owner/repo-b#2", repoFullName: "owner/repo-b", ruleReason: "blacklist" });
    await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.review_nag, actor: "someone-else", targetKey: "owner/repo-a#3", repoFullName: "owner/repo-a", ruleReason: "nag" });
    const count = await countModerationViolationsForActor(env, "farmer99", Object.values(MODERATION_VIOLATION_EVENT_TYPE));
    expect(count).toBe(2); // only farmer99's two, not someone-else's
  });

  it("respects an optional sinceIso rolling-window bound (violation-decay support)", async () => {
    const env = createTestEnv();
    await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.blacklist, actor: "farmer99", targetKey: "owner/repo#1", repoFullName: "owner/repo", ruleReason: "old" });
    const futureIso = new Date(Date.now() + 60_000).toISOString(); // strictly after the just-recorded violation
    const count = await countModerationViolationsForActor(env, "farmer99", [MODERATION_VIOLATION_EVENT_TYPE.blacklist], futureIso);
    expect(count).toBe(0); // outside the (future-dated, deliberately empty) window
  });

  it("returns 0 for an actor with no recorded violations", async () => {
    const env = createTestEnv();
    const count = await countModerationViolationsForActor(env, "nobody", Object.values(MODERATION_VIOLATION_EVENT_TYPE));
    expect(count).toBe(0);
  });

  it("REGRESSION (gate-flagged): recordModerationViolation is idempotent per (actor, eventType, targetKey) -- a webhook replay/queue retry re-recording the SAME close must not double-count it", async () => {
    const env = createTestEnv();
    const args = { eventType: MODERATION_VIOLATION_EVENT_TYPE.contributor_cap, actor: "farmer99", targetKey: "owner/repo#42", repoFullName: "owner/repo", ruleReason: "contributor_cap violation" };
    const firstInsert = await recordModerationViolation(env, args);
    const secondInsert = await recordModerationViolation(env, args); // simulates a redelivered webhook / retried queue job
    const thirdInsert = await recordModerationViolation(env, args);
    expect(firstInsert).toBe(true); // a genuinely new violation
    expect(secondInsert).toBe(false); // already recorded -- no-op
    expect(thirdInsert).toBe(false);
    const count = await countModerationViolationsForActor(env, "farmer99", [MODERATION_VIOLATION_EVENT_TYPE.contributor_cap]);
    expect(count).toBe(1); // NOT 3
  });

  it("a DIFFERENT targetKey (a different PR/issue) for the SAME actor+eventType is a genuinely new violation, not deduped", async () => {
    const env = createTestEnv();
    const first = await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.contributor_cap, actor: "farmer99", targetKey: "owner/repo#42", repoFullName: "owner/repo", ruleReason: "cap" });
    const second = await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.contributor_cap, actor: "farmer99", targetKey: "owner/repo#43", repoFullName: "owner/repo", ruleReason: "cap" });
    expect(first).toBe(true);
    expect(second).toBe(true);
    const count = await countModerationViolationsForActor(env, "farmer99", [MODERATION_VIOLATION_EVENT_TYPE.contributor_cap]);
    expect(count).toBe(2);
  });

  it("a DIFFERENT eventType on the SAME targetKey (e.g. a PR that trips both cap and blacklist) is a genuinely new violation, not deduped", async () => {
    const env = createTestEnv();
    const cap = await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.contributor_cap, actor: "farmer99", targetKey: "owner/repo#42", repoFullName: "owner/repo", ruleReason: "cap" });
    const blacklist = await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.blacklist, actor: "farmer99", targetKey: "owner/repo#42", repoFullName: "owner/repo", ruleReason: "blacklist" });
    expect(cap).toBe(true);
    expect(blacklist).toBe(true);
  });

  describe("hasModerationViolationForTarget", () => {
    it("returns false before any violation is recorded, true after, with NO time window (unlike hasRecentAuditEvent)", async () => {
      const env = createTestEnv();
      expect(await hasModerationViolationForTarget(env, "farmer99", MODERATION_VIOLATION_EVENT_TYPE.contributor_cap, "owner/repo#42")).toBe(false);
      await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.contributor_cap, actor: "farmer99", targetKey: "owner/repo#42", repoFullName: "owner/repo", ruleReason: "cap" });
      expect(await hasModerationViolationForTarget(env, "farmer99", MODERATION_VIOLATION_EVENT_TYPE.contributor_cap, "owner/repo#42")).toBe(true);
    });
  });

  describe("listModerationViolationsForActor (#fairness-analytics)", () => {
    it("returns every violation row for the actor, newest first, with repoFullName recovered from metadata_json", async () => {
      const env = createTestEnv();
      await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.contributor_cap, actor: "farmer99", targetKey: "owner/repo#1", repoFullName: "owner/repo", ruleReason: "cap" });
      await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.blacklist, actor: "farmer99", targetKey: "owner/repo#2", repoFullName: "owner/repo", ruleReason: "blacklist" });
      await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.review_nag, actor: "someone-else", targetKey: "owner/repo#3", repoFullName: "owner/repo", ruleReason: "nag" });

      const rows = await listModerationViolationsForActor(env, "farmer99", Object.values(MODERATION_VIOLATION_EVENT_TYPE));
      expect(rows).toHaveLength(2); // only farmer99's rows
      expect(rows.every((r) => r.repoFullName === "owner/repo")).toBe(true);
      expect(new Set(rows.map((r) => r.eventType))).toEqual(new Set([MODERATION_VIOLATION_EVENT_TYPE.contributor_cap, MODERATION_VIOLATION_EVENT_TYPE.blacklist]));
    });

    it("scopes by eventTypes -- omitting a rule type from the list excludes its violations", async () => {
      const env = createTestEnv();
      await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.contributor_cap, actor: "farmer99", targetKey: "owner/repo#1", repoFullName: "owner/repo", ruleReason: "cap" });
      await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.blacklist, actor: "farmer99", targetKey: "owner/repo#2", repoFullName: "owner/repo", ruleReason: "blacklist" });

      const rows = await listModerationViolationsForActor(env, "farmer99", [MODERATION_VIOLATION_EVENT_TYPE.contributor_cap]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.eventType).toBe(MODERATION_VIOLATION_EVENT_TYPE.contributor_cap);
    });

    it("honors an optional sinceIso lower bound, matching countModerationViolationsForActor's own decay window", async () => {
      const env = createTestEnv();
      await recordModerationViolation(env, { eventType: MODERATION_VIOLATION_EVENT_TYPE.blacklist, actor: "farmer99", targetKey: "owner/repo#1", repoFullName: "owner/repo", ruleReason: "old" });
      const futureIso = new Date(Date.now() + 60_000).toISOString();

      const rows = await listModerationViolationsForActor(env, "farmer99", [MODERATION_VIOLATION_EVENT_TYPE.blacklist], futureIso);
      expect(rows).toEqual([]);
    });

    it("returns [] for an actor with no violations", async () => {
      const env = createTestEnv();
      expect(await listModerationViolationsForActor(env, "nobody", Object.values(MODERATION_VIOLATION_EVENT_TYPE))).toEqual([]);
    });

    it("recovers repoFullName as '' (never throws) when metadata_json is malformed", async () => {
      const env = createTestEnv();
      await env.DB.prepare(`INSERT INTO audit_events (id, event_type, actor, outcome, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind("malformed-1", MODERATION_VIOLATION_EVENT_TYPE.blacklist, "farmer99", "completed", "not-json", new Date().toISOString())
        .run();
      const rows = await listModerationViolationsForActor(env, "farmer99", [MODERATION_VIOLATION_EVENT_TYPE.blacklist]);
      expect(rows).toEqual([{ eventType: MODERATION_VIOLATION_EVENT_TYPE.blacklist, repoFullName: "", targetKey: null, detail: null, createdAt: expect.any(String) }]);
    });

    it("recovers repoFullName as '' when metadata_json is valid JSON but repoFullName is missing or non-string", async () => {
      const env = createTestEnv();
      await env.DB.prepare(`INSERT INTO audit_events (id, event_type, actor, outcome, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind("no-repo-1", MODERATION_VIOLATION_EVENT_TYPE.blacklist, "farmer99", "completed", JSON.stringify({ repoFullName: 42 }), new Date().toISOString())
        .run();
      const rows = await listModerationViolationsForActor(env, "farmer99", [MODERATION_VIOLATION_EVENT_TYPE.blacklist]);
      expect(rows[0]!.repoFullName).toBe("");
    });
  });
});

describe("per-repo moderation settings config-as-code (#selfhost-mod-engine, Batch B loopover#6443)", () => {
  it("defaults to 'inherit' gate mode and undefined overrides for an unconfigured repo", async () => {
    const settings = await getRepositorySettings(createTestEnv(), "owner/none");
    expect(settings.moderationGateMode).toBe("inherit");
    expect(settings.moderationRules).toBeUndefined();
    expect(settings.moderationWarningLabel).toBeUndefined();
    expect(settings.moderationBannedLabel).toBeUndefined();
  });

  it("getRepositorySettings ignores a caller-supplied override on upsert -- these fields moved off the DB entirely, config-as-code only via .loopover.yml now", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, {
      repoFullName: "owner/repo",
      moderationGateMode: "enabled",
      moderationRules: ["blacklist"],
      moderationWarningLabel: "repo:warn",
      moderationBannedLabel: "repo:ban",
    });
    const settings = await getRepositorySettings(env, "owner/repo");
    expect(settings.moderationGateMode).toBe("inherit");
    expect(settings.moderationRules).toBeUndefined();
    expect(settings.moderationWarningLabel).toBeUndefined();
    expect(settings.moderationBannedLabel).toBeUndefined();
  });

  it("resolveRepositorySettings honors an explicit gate mode + rule override + custom labels from .loopover.yml's settings: block", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "owner/repo" });
    await upsertRepoFocusManifest(env, "owner/repo", {
      settings: {
        moderationGateMode: "enabled",
        moderationRules: ["blacklist"],
        moderationWarningLabel: "repo:warn",
        moderationBannedLabel: "repo:ban",
      },
    });
    const settings = await resolveRepositorySettings(env, "owner/repo");
    expect(settings.moderationGateMode).toBe("enabled");
    expect(settings.moderationRules).toEqual(["blacklist"]);
    expect(settings.moderationWarningLabel).toBe("repo:warn");
    expect(settings.moderationBannedLabel).toBe("repo:ban");
  });

  it("resolveRepositorySettings honors an explicit EMPTY moderationRules override distinctly from 'not configured' (undefined)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "owner/repo" });
    await upsertRepoFocusManifest(env, "owner/repo", { settings: { moderationRules: [] } });
    const settings = await resolveRepositorySettings(env, "owner/repo");
    expect(settings.moderationRules).toEqual([]);
  });

  it("moderationRules accepts review_evasion alongside the original three (#review-evasion-protection)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "owner/repo" });
    await upsertRepoFocusManifest(env, "owner/repo", { settings: { moderationRules: ["review_evasion", "blacklist"] } });
    const settings = await resolveRepositorySettings(env, "owner/repo");
    expect(settings.moderationRules).toEqual(["review_evasion", "blacklist"]);
  });
});

describe("per-repo review-evasion protection settings config-as-code (#review-evasion-protection, Batch B loopover#6443)", () => {
  it("defaults to close/review-evasion/true for an unconfigured repo (#4011: default-ON)", async () => {
    const settings = await getRepositorySettings(createTestEnv(), "owner/none");
    expect(settings.reviewEvasionProtection).toBe("close");
    expect(settings.reviewEvasionLabel).toBe(DEFAULT_REVIEW_EVASION_LABEL);
    expect(settings.reviewEvasionComment).toBe(true);
  });

  it("getRepositorySettings ignores a caller-supplied override on upsert -- these fields moved off the DB entirely, config-as-code only via .loopover.yml now", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, {
      repoFullName: "owner/repo",
      reviewEvasionProtection: "off",
      reviewEvasionLabel: "repo:evasion",
      reviewEvasionComment: false,
    });
    const settings = await getRepositorySettings(env, "owner/repo");
    expect(settings.reviewEvasionProtection).toBe("close");
    expect(settings.reviewEvasionLabel).toBe(DEFAULT_REVIEW_EVASION_LABEL);
    expect(settings.reviewEvasionComment).toBe(true);
  });

  it("resolveRepositorySettings honors an explicit protection mode + custom label + comment toggle from .loopover.yml's settings: block", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "owner/repo" });
    await upsertRepoFocusManifest(env, "owner/repo", {
      settings: {
        reviewEvasionProtection: "close",
        reviewEvasionLabel: "repo:evasion",
        reviewEvasionComment: false,
      },
    });
    const settings = await resolveRepositorySettings(env, "owner/repo");
    expect(settings.reviewEvasionProtection).toBe("close");
    expect(settings.reviewEvasionLabel).toBe("repo:evasion");
    expect(settings.reviewEvasionComment).toBe(false);
  });

  it("the explicit opt-out 'off' is honored via the manifest overlay (#4011)", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "owner/repo" });
    await upsertRepoFocusManifest(env, "owner/repo", { settings: { reviewEvasionProtection: "off" } });
    const settings = await resolveRepositorySettings(env, "owner/repo");
    expect(settings.reviewEvasionProtection).toBe("off");
  });
});
