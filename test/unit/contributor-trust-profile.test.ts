import { describe, expect, it } from "vitest";
import {
  getContributorTrustProfile,
  summarizeModerationViolationsByRepo,
} from "../../src/review/contributor-trust-profile";
import { recordModerationViolation, upsertRepositorySettings } from "../../src/db/repositories";
import { recordContributorGateDecision } from "../../src/review/contributor-calibration";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

const NOW = Date.parse("2026-07-20T00:00:00Z");
const DAY = 86_400_000;

async function insertReviewAuditOutcome(env: Env, project: string, targetId: string, decision: "merged" | "closed", createdAt: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO review_audit (id, project, target_id, event_type, decision, source, created_at) VALUES (?, ?, ?, 'pr_outcome', ?, 'github', ?)`,
  )
    .bind(`po:${targetId}:${createdAt}`, project, targetId, decision, createdAt)
    .run();
}

async function insertSubmitterStats(env: Env, project: string, submitter: string, over: Partial<{ submissions: number; merged: number; closed: number; manual: number; lastSeen: string }> = {}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO submitter_stats (project, submitter, submissions, merged, closed, manual, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(project, submitter, over.submissions ?? 1, over.merged ?? 1, over.closed ?? 0, over.manual ?? 0, over.lastSeen ?? new Date(NOW).toISOString())
    .run();
}

describe("summarizeModerationViolationsByRepo — pure fold (#fairness-analytics)", () => {
  const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

  it("groups violations by repo and computes a per-month rate when there's a real span", () => {
    const summaries = summarizeModerationViolationsByRepo([
      { repoFullName: "owner/a", eventType: "contributor_cap", createdAt: iso(30) },
      { repoFullName: "owner/a", eventType: "review_nag", createdAt: iso(0) },
    ]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.project).toBe("owner/a");
    expect(summaries[0]!.violationCount).toBe(2);
    expect(summaries[0]!.ruleTypes).toEqual(["contributor_cap", "review_nag"]); // deduped + sorted
    // span = 30 days = 1 month, 2 violations -> 2.0/month
    expect(summaries[0]!.ratePerMonth).toBe(2);
  });

  it("returns null ratePerMonth with fewer than 2 violations", () => {
    const summaries = summarizeModerationViolationsByRepo([{ repoFullName: "owner/a", eventType: "blacklist", createdAt: iso(0) }]);
    expect(summaries[0]!.violationCount).toBe(1);
    expect(summaries[0]!.ratePerMonth).toBeNull();
  });

  it("returns null ratePerMonth when the span is too thin to be meaningful, even with 2+ violations", () => {
    const summaries = summarizeModerationViolationsByRepo([
      { repoFullName: "owner/a", eventType: "review_nag", createdAt: iso(1) },
      { repoFullName: "owner/a", eventType: "review_nag", createdAt: iso(0) }, // 1-day span, below MIN_VIOLATION_SPAN_DAYS_FOR_RATE
    ]);
    expect(summaries[0]!.ratePerMonth).toBeNull();
  });

  it("skips a row with an empty repoFullName (malformed metadata) without throwing", () => {
    const summaries = summarizeModerationViolationsByRepo([
      { repoFullName: "", eventType: "blacklist", createdAt: iso(0) },
      { repoFullName: "owner/a", eventType: "blacklist", createdAt: iso(0) },
    ]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.project).toBe("owner/a");
  });

  it("drops a repo bucket entirely when every row has an unparseable createdAt", () => {
    const summaries = summarizeModerationViolationsByRepo([{ repoFullName: "owner/a", eventType: "blacklist", createdAt: "not-a-date" }]);
    expect(summaries).toEqual([]);
  });

  it("keeps a repo bucket when SOME rows have an unparseable createdAt but at least one is valid", () => {
    const summaries = summarizeModerationViolationsByRepo([
      { repoFullName: "owner/a", eventType: "blacklist", createdAt: "not-a-date" },
      { repoFullName: "owner/a", eventType: "blacklist", createdAt: iso(0) },
    ]);
    expect(summaries[0]!.violationCount).toBe(1);
  });

  it("sorts multiple repos by project name", () => {
    const summaries = summarizeModerationViolationsByRepo([
      { repoFullName: "owner/zeta", eventType: "blacklist", createdAt: iso(0) },
      { repoFullName: "owner/alpha", eventType: "blacklist", createdAt: iso(0) },
    ]);
    expect(summaries.map((s) => s.project)).toEqual(["owner/alpha", "owner/zeta"]);
  });

  it("returns [] for empty input", () => {
    expect(summarizeModerationViolationsByRepo([])).toEqual([]);
  });
});

describe("getContributorTrustProfile — end-to-end composition over real D1 (#fairness-analytics)", () => {
  it("composes submitter_stats + moderation violations + gate accuracy into one per-repo profile", async () => {
    const env = createTestEnv();

    await insertSubmitterStats(env, "owner/repo", "octocat", { submissions: 5, merged: 3, closed: 2 });

    await recordModerationViolation(env, { eventType: "moderation.violation.contributor_cap", actor: "octocat", targetKey: "owner/repo#1", repoFullName: "owner/repo", ruleReason: "contributor_cap violation" });
    await recordModerationViolation(env, { eventType: "moderation.violation.contributor_cap", actor: "octocat", targetKey: "owner/repo#2", repoFullName: "owner/repo", ruleReason: "contributor_cap violation" });

    await recordContributorGateDecision(env, { login: "octocat", project: "owner/repo", pullNumber: 3, headSha: "sha3", decision: "merge" });
    await insertReviewAuditOutcome(env, "owner/repo", "owner/repo#3", "merged", new Date(NOW).toISOString());

    const profile = await getContributorTrustProfile(env, "octocat", { nowMs: NOW });

    expect(profile.login).toBe("octocat");
    expect(profile.windowDays).toBe(90);
    expect(profile.repoStats).toEqual([{ project: "owner/repo", submissions: 5, merged: 3, closed: 2, manual: 0, lastSeen: expect.any(String) }]);
    expect(profile.moderation).toHaveLength(1);
    expect(profile.moderation[0]!.violationCount).toBe(2);
    expect(profile.gateAccuracy).toEqual([{ project: "owner/repo", decided: 1, weightedAccuracy: 1 }]);
    // #global-contributor-trust: with only one project in play, the blend equals that project's own row.
    expect(profile.blendedGateAccuracy).toEqual({ decided: 1, projectCount: 1, weightedAccuracy: 1 });
    expect(profile.totals).toEqual({ submissions: 5, merged: 3, closed: 2, violations: 2 });
  });

  it("#global-contributor-trust: blendedGateAccuracy pools gate decisions across TWO different repos for the same login", async () => {
    const env = createTestEnv();
    await recordContributorGateDecision(env, { login: "octocat", project: "owner/repo-a", pullNumber: 1, headSha: "sha1", decision: "merge" });
    await insertReviewAuditOutcome(env, "owner/repo-a", "owner/repo-a#1", "merged", new Date(NOW).toISOString());
    await recordContributorGateDecision(env, { login: "octocat", project: "owner/repo-b", pullNumber: 2, headSha: "sha2", decision: "close" });
    await insertReviewAuditOutcome(env, "owner/repo-b", "owner/repo-b#2", "merged", new Date(NOW).toISOString()); // false-close

    const profile = await getContributorTrustProfile(env, "octocat", { nowMs: NOW });

    expect(profile.gateAccuracy).toEqual(
      expect.arrayContaining([
        { project: "owner/repo-a", decided: 1, weightedAccuracy: 1 },
        { project: "owner/repo-b", decided: 1, weightedAccuracy: 0 },
      ]),
    );
    // Blended: 2 decided total, only 1 confirmed -> 0.5, pooled across both repos in one figure.
    expect(profile.blendedGateAccuracy).toEqual({ decided: 2, projectCount: 2, weightedAccuracy: 0.5 });
  });

  it("reads a null last_seen as null (the column is nullable, unlike submissions/merged/closed/manual)", async () => {
    const env = createTestEnv();
    await env.DB.prepare(`INSERT INTO submitter_stats (project, submitter, submissions, merged, closed, manual, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind("owner/repo", "octocat", 1, 1, 0, 0, null)
      .run();
    const profile = await getContributorTrustProfile(env, "octocat", { nowMs: NOW });
    expect(profile.repoStats[0]!.lastSeen).toBeNull();
  });

  it("defaults to a driver response with no `results` field (nullish fallback) as an empty repoStats list", async () => {
    const env = createTestEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/submitter_stats/i.test(sql)) return { bind: () => ({ all: async () => ({}) }) };
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    const profile = await getContributorTrustProfile(env, "octocat", { nowMs: NOW });
    expect(profile.repoStats).toEqual([]);
  });

  it("defaults nowMs to Date.now() when omitted", async () => {
    const env = createTestEnv();
    const profile = await getContributorTrustProfile(env, "octocat");
    expect(typeof profile.generatedAt).toBe("string");
    expect(profile.windowDays).toBe(90);
  });

  it("REGRESSION (#fairness-analytics): excludes a repo's submission counts AND moderation history when that repo opts out via its own .loopover.yml", async () => {
    const env = createTestEnv();
    await insertSubmitterStats(env, "owner/opted-out", "octocat", { submissions: 5 });
    await insertSubmitterStats(env, "owner/opted-in", "octocat", { submissions: 3 });
    await recordModerationViolation(env, { eventType: "moderation.violation.blacklist", actor: "octocat", targetKey: "owner/opted-out#1", repoFullName: "owner/opted-out", ruleReason: "blacklist violation" });
    await recordModerationViolation(env, { eventType: "moderation.violation.blacklist", actor: "octocat", targetKey: "owner/opted-in#1", repoFullName: "owner/opted-in", ruleReason: "blacklist violation" });
    await upsertRepositorySettings(env, { repoFullName: "owner/opted-out" });
    await upsertRepoFocusManifest(env, "owner/opted-out", { settings: { fairnessAnalyticsMode: "off" } });

    const profile = await getContributorTrustProfile(env, "octocat", { nowMs: NOW });

    expect(profile.repoStats.map((r) => r.project)).toEqual(["owner/opted-in"]);
    expect(profile.moderation.map((m) => m.project)).toEqual(["owner/opted-in"]);
    expect(profile.totals.submissions).toBe(3);
  });

  it("REGRESSION (#global-contributor-trust): blendedGateAccuracy excludes an opted-out repo's gate decisions from the pool", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "owner/opted-out" });
    await upsertRepoFocusManifest(env, "owner/opted-out", { settings: { fairnessAnalyticsMode: "off" } });

    await recordContributorGateDecision(env, { login: "octocat", project: "owner/opted-out", pullNumber: 1, headSha: "sha1", decision: "close" });
    await insertReviewAuditOutcome(env, "owner/opted-out", "owner/opted-out#1", "merged", new Date(NOW).toISOString()); // would be a false-close if counted
    await recordContributorGateDecision(env, { login: "octocat", project: "owner/opted-in", pullNumber: 2, headSha: "sha2", decision: "merge" });
    await insertReviewAuditOutcome(env, "owner/opted-in", "owner/opted-in#2", "merged", new Date(NOW).toISOString());

    const profile = await getContributorTrustProfile(env, "octocat", { nowMs: NOW });

    expect(profile.blendedGateAccuracy).toEqual({ decided: 1, projectCount: 1, weightedAccuracy: 1 });
  });

  it("never mixes another contributor's rows into the profile", async () => {
    const env = createTestEnv();
    await insertSubmitterStats(env, "owner/repo", "octocat", { submissions: 5 });
    await insertSubmitterStats(env, "owner/repo", "someone-else", { submissions: 99 });

    const profile = await getContributorTrustProfile(env, "octocat", { nowMs: NOW });
    expect(profile.repoStats).toHaveLength(1);
    expect(profile.repoStats[0]!.submissions).toBe(5);
  });

  it("returns an empty, zeroed profile for a contributor with no history anywhere", async () => {
    const env = createTestEnv();
    const profile = await getContributorTrustProfile(env, "nobody", { nowMs: NOW });
    expect(profile.repoStats).toEqual([]);
    expect(profile.moderation).toEqual([]);
    expect(profile.gateAccuracy).toEqual([]);
    expect(profile.blendedGateAccuracy).toBeNull();
    expect(profile.totals).toEqual({ submissions: 0, merged: 0, closed: 0, violations: 0 });
  });

  it("clamps an over-long days window to 730 and defaults a non-positive/non-finite days to 90", async () => {
    const env = createTestEnv();
    expect((await getContributorTrustProfile(env, "octocat", { days: 9999, nowMs: NOW })).windowDays).toBe(730);
    expect((await getContributorTrustProfile(env, "octocat", { days: -5, nowMs: NOW })).windowDays).toBe(90);
    expect((await getContributorTrustProfile(env, "octocat", { days: Number.NaN, nowMs: NOW })).windowDays).toBe(90);
  });

  it("is fail-safe: repoStats degrades to [] when submitter_stats read throws, without failing the rest of the profile", async () => {
    const env = createTestEnv();
    await recordModerationViolation(env, { eventType: "moderation.violation.blacklist", actor: "octocat", targetKey: "owner/repo#1", repoFullName: "owner/repo", ruleReason: "blacklist violation" });
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/submitter_stats/i.test(sql)) throw new Error("poisoned read");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;

    const profile = await getContributorTrustProfile(env, "octocat", { nowMs: NOW });
    expect(profile.repoStats).toEqual([]);
    expect(profile.moderation).toHaveLength(1); // unaffected by the poisoned submitter_stats read
  });

  it("is fail-safe: moderation degrades to [] when the violation read throws", async () => {
    const env = createTestEnv();
    await insertSubmitterStats(env, "owner/repo", "octocat", { submissions: 5 });
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/audit_events/i.test(sql)) throw new Error("poisoned read");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;

    const profile = await getContributorTrustProfile(env, "octocat", { nowMs: NOW });
    expect(profile.moderation).toEqual([]);
    expect(profile.repoStats).toHaveLength(1); // unaffected
  });
});
