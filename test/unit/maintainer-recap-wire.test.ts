import { afterEach, describe, expect, it, vi } from "vitest";
import { isRecapEnabled, runMaintainerRecapJob, shouldFireMaintainerRecap } from "../../src/review/maintainer-recap-wire";
import { updatePullRequestSlopAssessment, upsertPullRequestFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import { createTestEnv } from "../helpers/d1";

const HOOK = "https://discord.com/api/webhooks/123/abc";

// Wrap env.DB.prepare so any SQL matching `pattern` throws, exercising a fail-safe catch; every other
// query delegates to the real test DB unchanged. Mirrors ops-wire.test.ts's poisonDbPrepare.
function poisonDbPrepare(env: Env, pattern: RegExp): void {
  const realPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = ((sql: string) => {
    if (pattern.test(sql)) throw new Error("poisoned query");
    return realPrepare(sql);
  }) as typeof env.DB.prepare;
}

// Mark a repo registered so recapScanRepos picks it up (mirrors ops-wire.test.ts's seedRegisteredRepo).
async function seedRegisteredRepo(env: Env, fullName: string): Promise<void> {
  const [owner, name] = fullName.split("/");
  await (env.DB as unknown as { prepare: (s: string) => { bind: (...v: unknown[]) => { run: () => Promise<unknown> } } })
    .prepare("INSERT INTO repositories (full_name, owner, name, is_installed, is_registered) VALUES (?, ?, ?, 1, 1)")
    .bind(fullName, owner, name)
    .run();
}

// A resolved, merged PR carrying a slop assessment so it counts in buildRepoOutcomeCalibration's slop bands.
async function seedMergedPr(env: Env, repoFullName: string, number: number): Promise<void> {
  await upsertPullRequestFromGitHub(env, repoFullName, { number, title: `PR ${number}`, state: "closed", merged_at: "2026-06-01T00:00:00.000Z" });
  await updatePullRequestSlopAssessment(env, repoFullName, number, { slopRisk: 0, slopBand: "clean" });
}

// Only RECORDS calls to the Discord webhook itself -- recapScanRepos's resolveRepositorySettings also fetches
// each repo's .gittensory.yml (loadRepoFocusManifest), which must keep succeeding (generic 204) but not be
// mistaken for a webhook post.
function stubDiscordFetch(): Array<{ body: string }> {
  const calls: Array<{ body: string }> = [];
  vi.stubGlobal("fetch", async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === HOOK) calls.push({ body: init?.body ? String(init.body) : "" });
    return new Response(null, { status: 204 });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isRecapEnabled — default OFF, truthy convention", () => {
  it("is OFF for unset / false / empty, ON for 1/true/yes/on", () => {
    for (const off of [undefined, "", "false", "no", "0", "off"]) expect(isRecapEnabled({ GITTENSORY_MAINTAINER_RECAP: off })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "TRUE", "On"]) expect(isRecapEnabled({ GITTENSORY_MAINTAINER_RECAP: on })).toBe(true);
  });
});

describe("shouldFireMaintainerRecap — cadence gate (#2248)", () => {
  it("fires the weekly default (Monday 14:00 UTC) and nowhere else", () => {
    expect(shouldFireMaintainerRecap({}, 14, 1)).toBe(true); // Monday @ 14:00 UTC
    expect(shouldFireMaintainerRecap({}, 14, 2)).toBe(false); // wrong day
    expect(shouldFireMaintainerRecap({}, 15, 1)).toBe(false); // wrong hour
  });

  it("an explicit weekly cadence behaves exactly like the default", () => {
    expect(shouldFireMaintainerRecap({ GITTENSORY_RECAP_CADENCE: "weekly" }, 14, 1)).toBe(true);
    expect(shouldFireMaintainerRecap({ GITTENSORY_RECAP_CADENCE: "weekly" }, 14, 2)).toBe(false);
  });

  it("daily cadence fires every day at the configured hour, ignoring day-of-week", () => {
    const env = { GITTENSORY_RECAP_CADENCE: "daily" };
    expect(shouldFireMaintainerRecap(env, 14, 1)).toBe(true);
    expect(shouldFireMaintainerRecap(env, 14, 3)).toBe(true);
    expect(shouldFireMaintainerRecap(env, 14, 6)).toBe(true);
    expect(shouldFireMaintainerRecap(env, 15, 3)).toBe(false); // still hour-gated
  });

  it("an invalid cadence value falls back to weekly (not daily), so a typo can't quietly fire more often", () => {
    const env = { GITTENSORY_RECAP_CADENCE: "biweekly" };
    expect(shouldFireMaintainerRecap(env, 14, 1)).toBe(true); // Monday still fires (weekly default)
    expect(shouldFireMaintainerRecap(env, 14, 2)).toBe(false); // Tuesday does not — proves it is NOT daily
  });

  it("respects a custom configured hour and day-of-week", () => {
    const env = { GITTENSORY_RECAP_CADENCE: "weekly", GITTENSORY_RECAP_HOUR: "3", GITTENSORY_RECAP_DAY: "5" };
    expect(shouldFireMaintainerRecap(env, 3, 5)).toBe(true);
    expect(shouldFireMaintainerRecap(env, 3, 1)).toBe(false); // the default Monday no longer applies
    expect(shouldFireMaintainerRecap(env, 14, 5)).toBe(false); // the default hour no longer applies
  });

  it("clamps an out-of-range (but finite) hour/day to the nearest bound", () => {
    const env = { GITTENSORY_RECAP_HOUR: "99", GITTENSORY_RECAP_DAY: "-3" };
    expect(shouldFireMaintainerRecap(env, 23, 0)).toBe(true); // 99 → 23 (MAX_HOUR), -3 → 0 (MIN_DAY_OF_WEEK)
    expect(shouldFireMaintainerRecap(env, 14, 1)).toBe(false); // the (unclamped) default no longer matches
  });

  it("falls back to the default hour/day on a non-finite value", () => {
    const env = { GITTENSORY_RECAP_HOUR: "not-a-number", GITTENSORY_RECAP_DAY: "nope" };
    expect(shouldFireMaintainerRecap(env, 14, 1)).toBe(true); // falls back to 14 / Monday
  });
});

describe("runMaintainerRecapJob — cross-repo digest (#1963, #2248)", () => {
  it("aggregates gate-precision + calibration across every registered repo (none agent-configured → fallback to all) and delivers to Discord", async () => {
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: HOOK });
    await seedRegisteredRepo(env, "owner/alpha");
    await seedMergedPr(env, "owner/alpha", 1);
    await seedRegisteredRepo(env, "owner/beta");
    await seedMergedPr(env, "owner/beta", 1);
    await seedMergedPr(env, "owner/beta", 2);
    const posted = stubDiscordFetch();

    const { report, delivery } = await runMaintainerRecapJob(env);

    expect(delivery).toEqual({ sent: true });
    expect(report.windowDays).toBe(7); // default when omitted
    expect(report.repos.map((r) => r.repoFullName).sort()).toEqual(["owner/alpha", "owner/beta"]);
    expect(report.totals.merged).toBe(3); // 1 (alpha) + 2 (beta)
    expect(posted).toHaveLength(1);
  });

  it("threads a custom windowDays through to the report and the per-repo aggregators", async () => {
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: HOOK });
    await seedRegisteredRepo(env, "owner/alpha");
    await seedMergedPr(env, "owner/alpha", 1);
    stubDiscordFetch();

    const { report } = await runMaintainerRecapJob(env, 30);

    expect(report.windowDays).toBe(30);
  });

  it("prefers agent-configured repos over the full registered set when at least one is configured", async () => {
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: HOOK });
    await seedRegisteredRepo(env, "owner/configured");
    await seedMergedPr(env, "owner/configured", 1);
    await upsertRepositorySettings(env, { repoFullName: "owner/configured", autonomy: { merge: "auto" } });
    await seedRegisteredRepo(env, "owner/unconfigured");
    await seedMergedPr(env, "owner/unconfigured", 1);
    stubDiscordFetch();

    const { report } = await runMaintainerRecapJob(env);

    expect(report.repos.map((r) => r.repoFullName)).toEqual(["owner/configured"]);
  });

  it("falls back to every registered repo when settings resolution errors for every repo (a settings blip must not abort the scan)", async () => {
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: HOOK });
    await seedRegisteredRepo(env, "owner/alpha");
    await seedMergedPr(env, "owner/alpha", 1);
    await seedRegisteredRepo(env, "owner/beta");
    await seedMergedPr(env, "owner/beta", 1);
    // resolveRepositorySettings reads repository_settings; poisoning it makes every repo's lookup throw, so
    // recapScanRepos's inner catch fires for each and `configured` stays empty.
    poisonDbPrepare(env, /"repository_settings"/i);
    stubDiscordFetch();

    const { report } = await runMaintainerRecapJob(env);

    expect(report.repos.map((r) => r.repoFullName).sort()).toEqual(["owner/alpha", "owner/beta"]);
  });

  it("fails safe per-repo: an aggregator error is logged and the repo is skipped; the job still delivers a (zeroed) report", async () => {
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: HOOK });
    await seedRegisteredRepo(env, "owner/alpha");
    await seedMergedPr(env, "owner/alpha", 1);
    // gate-precision reads pull_requests (Drizzle, quoted table name) per repo.
    poisonDbPrepare(env, /"pull_requests"/i);
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubDiscordFetch();

    const { report, delivery } = await runMaintainerRecapJob(env); // resolves (never throws)

    expect(report.repos).toEqual([]);
    expect(delivery).toEqual({ sent: true });
    const logged = warnings.mock.calls.map((c) => String(c[0])).find((line) => line.includes("maintainer_recap_repo_error") && line.includes("owner/alpha"));
    expect(logged).toBeDefined();
  });

  it("still delivers a zeroed report to Discord when there are no registered repos at all", async () => {
    const env = createTestEnv({ DISCORD_WEBHOOK_URL: HOOK });
    stubDiscordFetch();

    const { report, delivery } = await runMaintainerRecapJob(env);

    expect(report.repos).toEqual([]);
    expect(report.totals.gateFalsePositiveRate).toBeNull();
    expect(delivery).toEqual({ sent: true });
  });
});
