import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFairnessAnalyticsManifestOverrideCacheForTest,
  isFairnessAnalyticsEnabled,
  resolveEligibleFairnessAnalyticsProjects,
  resolveFairnessAnalyticsManifestOverride,
  resolveFairnessAnalyticsParticipation,
} from "../../src/review/contributor-trust-profile-wire";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import { upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const SELF_REPO = "JSONbored/loopover";

describe("isFairnessAnalyticsEnabled (#fairness-analytics)", () => {
  it("is truthy only for 1/true/yes/on (case-insensitive)", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) expect(isFairnessAnalyticsEnabled({ LOOPOVER_FAIRNESS_ANALYTICS: v })).toBe(true);
    for (const v of ["", "0", "false", "off", "no", undefined]) expect(isFairnessAnalyticsEnabled({ LOOPOVER_FAIRNESS_ANALYTICS: v })).toBe(false);
  });

  it("a present manifest override wins outright over the env flag, in both directions", () => {
    expect(isFairnessAnalyticsEnabled({ LOOPOVER_FAIRNESS_ANALYTICS: "false" }, { present: true, enabled: true })).toBe(true);
    expect(isFairnessAnalyticsEnabled({ LOOPOVER_FAIRNESS_ANALYTICS: "true" }, { present: true, enabled: false })).toBe(false);
  });

  it("falls back to the env flag when the manifest override is not present", () => {
    expect(isFairnessAnalyticsEnabled({ LOOPOVER_FAIRNESS_ANALYTICS: "true" }, { present: false, enabled: false })).toBe(true);
    expect(isFairnessAnalyticsEnabled({ LOOPOVER_FAIRNESS_ANALYTICS: "false" }, undefined)).toBe(false);
  });
});

describe("resolveFairnessAnalyticsManifestOverride — config-as-code lookup (#fairness-analytics)", () => {
  beforeEach(() => {
    clearFairnessAnalyticsManifestOverrideCacheForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the self-repo's configured fairnessAnalytics block when present", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { fairnessAnalytics: { enabled: true } });

    expect(await resolveFairnessAnalyticsManifestOverride(env)).toEqual({ present: true, enabled: true });
  });

  it("returns present: false when the self-repo has no fairnessAnalytics block configured", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { wantedPaths: ["src/"] });

    expect(await resolveFairnessAnalyticsManifestOverride(env)).toEqual({ present: false, enabled: false });
  });

  it("degrades to present: false (never throws) when the manifest load itself fails", async () => {
    const env = createTestEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/"signal_snapshots"|signal_snapshots/i.test(sql)) throw new Error("poisoned query");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await resolveFairnessAnalyticsManifestOverride(env)).toEqual({ present: false, enabled: false });
    expect(warnings.mock.calls.map((c) => String(c[0])).some((line) => line.includes("fairness_analytics_manifest_override_error"))).toBe(true);
  });

  it("within the 60s TTL, reuses the cached override instead of re-reading the manifest", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { fairnessAnalytics: { enabled: true } });
    const t0 = Date.parse("2026-07-20T00:00:00Z");
    expect(await resolveFairnessAnalyticsManifestOverride(env, t0)).toEqual({ present: true, enabled: true });

    env.DB.prepare = (() => {
      throw new Error("should not be queried on a cache hit");
    }) as typeof env.DB.prepare;
    expect(await resolveFairnessAnalyticsManifestOverride(env, t0 + 30_000)).toEqual({ present: true, enabled: true });
  });

  it("re-reads the manifest once the 60s TTL has elapsed", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { fairnessAnalytics: { enabled: true } });
    const t0 = Date.parse("2026-07-20T00:00:00Z");
    expect(await resolveFairnessAnalyticsManifestOverride(env, t0)).toEqual({ present: true, enabled: true });

    await upsertRepoFocusManifest(env, SELF_REPO, { fairnessAnalytics: { enabled: false } });
    expect(await resolveFairnessAnalyticsManifestOverride(env, t0 + 60_001)).toEqual({ present: true, enabled: false });
  });
});

describe("resolveFairnessAnalyticsParticipation (#fairness-analytics)", () => {
  it("participates for inherit, enabled, or unset; excludes only for off", () => {
    expect(resolveFairnessAnalyticsParticipation("inherit")).toBe(true);
    expect(resolveFairnessAnalyticsParticipation("enabled")).toBe(true);
    expect(resolveFairnessAnalyticsParticipation(undefined)).toBe(true);
    expect(resolveFairnessAnalyticsParticipation("off")).toBe(false);
  });
});

describe("resolveEligibleFairnessAnalyticsProjects (#fairness-analytics)", () => {
  it("excludes a project whose settings resolve to fairnessAnalyticsMode: off", async () => {
    const env = createTestEnv();
    await upsertRepositorySettings(env, { repoFullName: "owner/opted-out" });
    await upsertRepoFocusManifest(env, "owner/opted-out", { settings: { fairnessAnalyticsMode: "off" } });

    const eligible = await resolveEligibleFairnessAnalyticsProjects(env, ["owner/opted-out", "owner/opted-in", "owner/opted-out"]);
    expect(eligible).toEqual(new Set(["owner/opted-in"]));
  });

  it("returns an empty set for empty input", async () => {
    const env = createTestEnv();
    expect(await resolveEligibleFairnessAnalyticsProjects(env, [])).toEqual(new Set());
  });

  it("defaults to eligible when settings resolution throws (fail-open)", async () => {
    const env = createTestEnv();
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/repository_settings/i.test(sql)) throw new Error("poisoned settings read");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;

    expect(await resolveEligibleFairnessAnalyticsProjects(env, ["owner/repo"])).toEqual(new Set(["owner/repo"]));
  });
});
