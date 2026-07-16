import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSweepWatchdogManifestOverrideCacheForTest,
  isSweepStale,
  isSweepWatchdogEnabled,
  resolveSweepStalenessThresholdMs,
  resolveSweepWatchdogManifestOverride,
  runSweepLivenessWatchdog,
  SWEEP_STALENESS_THRESHOLD_MS,
} from "../../src/review/sweep-watchdog";
import { markPullRequestsRegated, upsertPullRequestFromGitHub, upsertRepositoryFromGitHub, upsertRepositorySettings } from "../../src/db/repositories";
import * as repositoriesModule from "../../src/db/repositories";
import { upsertRepoFocusManifest } from "../../src/signals/focus-manifest-loader";
import * as focusManifestLoaderModule from "../../src/signals/focus-manifest-loader";
import { createTestEnv } from "../helpers/d1";

const SELF_REPO = "JSONbored/gittensory";

describe("isSweepWatchdogEnabled — default OFF, truthy convention", () => {
  it("matches the codebase's shared truthy-string convention", () => {
    for (const off of [undefined, "", "false", "no", "0", "off"]) expect(isSweepWatchdogEnabled({ LOOPOVER_SWEEP_WATCHDOG: off })).toBe(false);
    for (const on of ["1", "true", "yes", "on", "TRUE", "On"]) expect(isSweepWatchdogEnabled({ LOOPOVER_SWEEP_WATCHDOG: on })).toBe(true);
  });

  it("a present manifest override wins outright over the env flag, in both directions (#6558)", () => {
    expect(isSweepWatchdogEnabled({ LOOPOVER_SWEEP_WATCHDOG: "false" }, { present: true, enabled: true, staleAfterMinutes: null })).toBe(true);
    expect(isSweepWatchdogEnabled({ LOOPOVER_SWEEP_WATCHDOG: "true" }, { present: true, enabled: false, staleAfterMinutes: null })).toBe(false);
  });

  it("falls back to the env flag when the manifest override is not present", () => {
    expect(isSweepWatchdogEnabled({ LOOPOVER_SWEEP_WATCHDOG: "true" }, { present: false, enabled: false, staleAfterMinutes: null })).toBe(true);
    expect(isSweepWatchdogEnabled({ LOOPOVER_SWEEP_WATCHDOG: "false" }, undefined)).toBe(false);
  });
});

describe("resolveSweepWatchdogManifestOverride — config-as-code lookup (#6558)", () => {
  beforeEach(() => {
    clearSweepWatchdogManifestOverrideCacheForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the self-repo's configured sweepWatchdog block when present", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { sweepWatchdog: { enabled: true } });

    expect(await resolveSweepWatchdogManifestOverride(env)).toEqual({
      present: true,
      enabled: true,
      staleAfterMinutes: null,
    });
  });

  it("returns present: false when the self-repo has no sweepWatchdog block configured", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { wantedPaths: ["src/"] });

    expect(await resolveSweepWatchdogManifestOverride(env)).toEqual({
      present: false,
      enabled: false,
      staleAfterMinutes: null,
    });
  });

  it("carries staleAfterMinutes through from the self-repo manifest (#6594)", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { sweepWatchdog: { enabled: true, staleAfterMinutes: 90 } });

    expect(await resolveSweepWatchdogManifestOverride(env)).toEqual({
      present: true,
      enabled: true,
      staleAfterMinutes: 90,
    });
  });

  it("degrades to present: false (never throws) when the manifest load itself fails", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    const realPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      if (/"signal_snapshots"|signal_snapshots/i.test(sql)) throw new Error("poisoned query");
      return realPrepare(sql);
    }) as typeof env.DB.prepare;
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await resolveSweepWatchdogManifestOverride(env)).toEqual({
      present: false,
      enabled: false,
      staleAfterMinutes: null,
    });
    expect(warnings.mock.calls.map((c) => String(c[0])).some((line) => line.includes("sweep_watchdog_manifest_override_error"))).toBe(true);
  });

  it("within the 60s TTL, reuses the cached override instead of re-reading the manifest", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { sweepWatchdog: { enabled: true } });
    const t0 = Date.parse("2026-07-16T00:00:00Z");
    expect(await resolveSweepWatchdogManifestOverride(env, t0)).toEqual({
      present: true,
      enabled: true,
      staleAfterMinutes: null,
    });

    env.DB.prepare = (() => {
      throw new Error("should not be queried on a cache hit");
    }) as typeof env.DB.prepare;
    expect(await resolveSweepWatchdogManifestOverride(env, t0 + 30_000)).toEqual({
      present: true,
      enabled: true,
      staleAfterMinutes: null,
    });
  });

  it("re-reads the manifest once the 60s TTL has elapsed", async () => {
    const env = createTestEnv({ LOOPOVER_DRIFT_ISSUE_REPO: SELF_REPO });
    await upsertRepoFocusManifest(env, SELF_REPO, { sweepWatchdog: { enabled: true } });
    const t0 = Date.parse("2026-07-16T00:00:00Z");
    expect(await resolveSweepWatchdogManifestOverride(env, t0)).toEqual({
      present: true,
      enabled: true,
      staleAfterMinutes: null,
    });

    await upsertRepoFocusManifest(env, SELF_REPO, { sweepWatchdog: { enabled: false } });
    expect(await resolveSweepWatchdogManifestOverride(env, t0 + 60_001)).toEqual({
      present: true,
      enabled: false,
      staleAfterMinutes: null,
    });
  });
});

describe("isSweepStale (#audit-sweep-fanout-isolation follow-up)", () => {
  const NOW = Date.parse("2026-07-06T12:00:00.000Z");

  it("a repo with NO open PRs is never stale, regardless of the marker", () => {
    expect(isSweepStale({ openPullRequestCount: 0, lastRegatedAt: null, nowMs: NOW })).toBe(false);
    expect(isSweepStale({ openPullRequestCount: 0, lastRegatedAt: "2020-01-01T00:00:00.000Z", nowMs: NOW })).toBe(false);
  });

  it("a repo with open PRs and NO regate marker at all is stale (never regated)", () => {
    expect(isSweepStale({ openPullRequestCount: 1, lastRegatedAt: null, nowMs: NOW })).toBe(true);
  });

  it("a repo with open PRs and an unparseable marker is stale (fails toward stale, not silently healthy)", () => {
    expect(isSweepStale({ openPullRequestCount: 1, lastRegatedAt: "not-a-date", nowMs: NOW })).toBe(true);
  });

  it("a repo regated within the staleness window is NOT stale", () => {
    const lastRegatedAt = new Date(NOW - (SWEEP_STALENESS_THRESHOLD_MS - 1000)).toISOString();
    expect(isSweepStale({ openPullRequestCount: 1, lastRegatedAt, nowMs: NOW })).toBe(false);
  });

  it("a repo NOT regated within the staleness window IS stale", () => {
    const lastRegatedAt = new Date(NOW - (SWEEP_STALENESS_THRESHOLD_MS + 1000)).toISOString();
    expect(isSweepStale({ openPullRequestCount: 1, lastRegatedAt, nowMs: NOW })).toBe(true);
  });

  it("an explicit staleAfterMs override changes the stale/not-stale boundary (#6594)", () => {
    const overrideMs = 10 * 60_000;
    const withinOverride = new Date(NOW - (overrideMs - 1000)).toISOString();
    const outsideOverride = new Date(NOW - (overrideMs + 1000)).toISOString();
    // Still inside the hardcoded 45m default, but outside a 10m override → stale under the override only.
    expect(isSweepStale({ openPullRequestCount: 1, lastRegatedAt: withinOverride, nowMs: NOW, staleAfterMs: overrideMs })).toBe(
      false,
    );
    expect(isSweepStale({ openPullRequestCount: 1, lastRegatedAt: outsideOverride, nowMs: NOW, staleAfterMs: overrideMs })).toBe(
      true,
    );
    expect(isSweepStale({ openPullRequestCount: 1, lastRegatedAt: outsideOverride, nowMs: NOW })).toBe(false);
  });

  it("omitted / non-positive staleAfterMs preserves today's 45-minute default exactly (#6594)", () => {
    const lastRegatedAt = new Date(NOW - (SWEEP_STALENESS_THRESHOLD_MS + 1000)).toISOString();
    expect(isSweepStale({ openPullRequestCount: 1, lastRegatedAt, nowMs: NOW })).toBe(true);
    expect(isSweepStale({ openPullRequestCount: 1, lastRegatedAt, nowMs: NOW, staleAfterMs: 0 })).toBe(true);
    expect(isSweepStale({ openPullRequestCount: 1, lastRegatedAt, nowMs: NOW, staleAfterMs: -1 })).toBe(true);
    expect(isSweepStale({ openPullRequestCount: 1, lastRegatedAt, nowMs: NOW, staleAfterMs: Number.NaN })).toBe(true);
  });
});

describe("resolveSweepStalenessThresholdMs (#6594)", () => {
  it("returns the hardcoded default when the override is absent or minutes are null", () => {
    expect(resolveSweepStalenessThresholdMs(undefined)).toBe(SWEEP_STALENESS_THRESHOLD_MS);
    expect(resolveSweepStalenessThresholdMs({ present: false, enabled: false, staleAfterMinutes: null })).toBe(
      SWEEP_STALENESS_THRESHOLD_MS,
    );
    expect(resolveSweepStalenessThresholdMs({ present: true, enabled: true, staleAfterMinutes: null })).toBe(
      SWEEP_STALENESS_THRESHOLD_MS,
    );
  });

  it("converts a present positive staleAfterMinutes to milliseconds", () => {
    expect(resolveSweepStalenessThresholdMs({ present: true, enabled: true, staleAfterMinutes: 90 })).toBe(90 * 60_000);
  });
});

describe("runSweepLivenessWatchdog (#audit-sweep-fanout-isolation follow-up)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("re-enqueues a targeted sweep + logs sweep_liveness_stale for an installed repo with open PRs whose marker never advanced", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "stale-repo", full_name: "owner/stale-repo", private: false, owner: { login: "owner" } }, 9300);
    await upsertRepositorySettings(env, { repoFullName: "owner/stale-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/stale-repo", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const found = await runSweepLivenessWatchdog(env);

    expect(found).toEqual([expect.objectContaining({ repoFullName: "owner/stale-repo", installationId: 9300, openPullRequestCount: 1 })]);
    expect(sent).toEqual([expect.objectContaining({ type: "agent-regate-sweep", requestedBy: "schedule", repoFullName: "owner/stale-repo", installationId: 9300 })]);
    const logged = errors.mock.calls.map((c) => String(c[0])).find((line) => line.includes("sweep_liveness_stale") && line.includes("owner/stale-repo"));
    expect(logged).toBeDefined();
    expect(JSON.parse(logged!)).toMatchObject({ level: "error", event: "sweep_liveness_stale", repository: "owner/stale-repo" });
  });

  it("REGRESSION: reports a finite ageMs for a repo that WAS regated once but fell outside the staleness window (not just a never-regated null marker)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const start = new Date("2026-07-06T10:00:00.000Z");
    vi.setSystemTime(start);
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "aged-repo", full_name: "owner/aged-repo", private: false, owner: { login: "owner" } }, 9306);
    await upsertRepositorySettings(env, { repoFullName: "owner/aged-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/aged-repo", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    await markPullRequestsRegated(env, "owner/aged-repo", [1]); // stamps last_regated_at = start
    vi.setSystemTime(new Date(start.getTime() + SWEEP_STALENESS_THRESHOLD_MS + 60_000)); // now outside the window

    const found = await runSweepLivenessWatchdog(env);

    expect(found).toEqual([expect.objectContaining({ repoFullName: "owner/aged-repo", lastRegatedAt: start.toISOString(), ageMs: SWEEP_STALENESS_THRESHOLD_MS + 60_000 })]);
    expect(Number.isFinite(found[0]?.ageMs)).toBe(true);
    expect(sent).toEqual([expect.objectContaining({ type: "agent-regate-sweep", repoFullName: "owner/aged-repo" })]);
  }, 60_000);

  it("threads a present staleAfterMinutes override into the stale decision (#6594)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const start = new Date("2026-07-06T10:00:00.000Z");
    vi.setSystemTime(start);
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "override-repo", full_name: "owner/override-repo", private: false, owner: { login: "owner" } }, 9310);
    await upsertRepositorySettings(env, { repoFullName: "owner/override-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/override-repo", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    await markPullRequestsRegated(env, "owner/override-repo", [1]);
    // 15 minutes later: still inside the 45m default, but outside a 10m override.
    vi.setSystemTime(new Date(start.getTime() + 15 * 60_000));

    const notStaleUnderDefault = await runSweepLivenessWatchdog(env, {
      present: true,
      enabled: true,
      staleAfterMinutes: null,
    });
    expect(notStaleUnderDefault).toEqual([]);

    const staleUnderOverride = await runSweepLivenessWatchdog(env, {
      present: true,
      enabled: true,
      staleAfterMinutes: 10,
    });
    expect(staleUnderOverride).toEqual([
      expect.objectContaining({
        repoFullName: "owner/override-repo",
        installationId: 9310,
        openPullRequestCount: 1,
        lastRegatedAt: start.toISOString(),
      }),
    ]);
    expect(staleUnderOverride[0]?.ageMs).toBeGreaterThan(10 * 60_000);
    expect(staleUnderOverride[0]?.ageMs).toBeLessThan(SWEEP_STALENESS_THRESHOLD_MS);
    expect(sent).toEqual([expect.objectContaining({ type: "agent-regate-sweep", repoFullName: "owner/override-repo" })]);
  }, 60_000);

  it("watches an ALLOWLISTED (LOOPOVER_REVIEW_REPOS) installed repo even with no autonomy configured, and skips a plain repo that is neither allowlisted nor agent-configured", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({
      LOOPOVER_REVIEW_REPOS: "owner/allowlisted-repo",
      JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue,
    });
    // Allowlisted + installed, but NO autonomy config at all — isConvergenceRepoAllowed alone must still watch it.
    await upsertRepositoryFromGitHub(env, { name: "allowlisted-repo", full_name: "owner/allowlisted-repo", private: false, owner: { login: "owner" } }, 9307);
    await upsertPullRequestFromGitHub(env, "owner/allowlisted-repo", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    // Neither allowlisted nor agent-configured — must be excluded entirely, regardless of its own staleness.
    await upsertRepositoryFromGitHub(env, { name: "plain-repo", full_name: "owner/plain-repo", private: false, owner: { login: "owner" } }, 9308);
    await upsertPullRequestFromGitHub(env, "owner/plain-repo", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });

    const found = await runSweepLivenessWatchdog(env);

    expect(found.map((f) => f.repoFullName)).toEqual(["owner/allowlisted-repo"]);
    expect(sent).toEqual([expect.objectContaining({ repoFullName: "owner/allowlisted-repo", installationId: 9307 })]);
  });

  it("fails safe at the top level: a total scan failure (e.g. listRepositories throwing) is logged and returns an empty result instead of throwing", async () => {
    const env = createTestEnv();
    const listSpy = vi.spyOn(repositoriesModule, "listRepositories").mockRejectedValueOnce(new Error("D1 unavailable"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runSweepLivenessWatchdog(env)).resolves.toEqual([]);

    expect(errors.mock.calls.some((call) => String(call[0]).includes("sweep_liveness_error"))).toBe(true);
    listSpy.mockRestore();
  });

  it("does NOT re-enqueue a repo regated within the staleness window", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "fresh-repo", full_name: "owner/fresh-repo", private: false, owner: { login: "owner" } }, 9301);
    await upsertRepositorySettings(env, { repoFullName: "owner/fresh-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/fresh-repo", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    await markPullRequestsRegated(env, "owner/fresh-repo", [1]);

    const found = await runSweepLivenessWatchdog(env);

    expect(found).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("does NOT flag a repo with zero open PRs, even with no regate marker at all", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "quiet-repo", full_name: "owner/quiet-repo", private: false, owner: { login: "owner" } }, 9302);
    await upsertRepositorySettings(env, { repoFullName: "owner/quiet-repo", autonomy: { merge: "auto" } });

    const found = await runSweepLivenessWatchdog(env);

    expect(found).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("never flags a registered-but-uninstalled repo (#sweep-uninstalled-budget-waste) — no per-PR fan-out could ever help it", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ LOOPOVER_REVIEW_REPOS: "owner/no-install", JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "no-install", full_name: "owner/no-install", private: false, owner: { login: "owner" } }); // no installation id
    await upsertRepositorySettings(env, { repoFullName: "owner/no-install", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/no-install", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });

    const found = await runSweepLivenessWatchdog(env);

    expect(found).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("fails safe per-repo: a load error on one repo is logged and the scan continues to the next repo", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "erroring-repo", full_name: "owner/erroring-repo", private: false, owner: { login: "owner" } }, 9303);
    await upsertRepositorySettings(env, { repoFullName: "owner/erroring-repo", autonomy: { merge: "auto" } });
    await upsertRepositoryFromGitHub(env, { name: "ok-repo", full_name: "owner/ok-repo", private: false, owner: { login: "owner" } }, 9304);
    await upsertRepositorySettings(env, { repoFullName: "owner/ok-repo", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/erroring-repo", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    await upsertPullRequestFromGitHub(env, "owner/ok-repo", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    const countSpy = vi.spyOn(repositoriesModule, "countOpenPullRequests").mockImplementation(async (_env, fullName) => {
      if (fullName === "owner/erroring-repo") throw new Error("D1 read error");
      return 1;
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const found = await runSweepLivenessWatchdog(env);

    expect(found).toEqual([expect.objectContaining({ repoFullName: "owner/ok-repo" })]); // erroring-repo's failure did not block ok-repo
    expect(errors.mock.calls.some((call) => String(call[0]).includes("sweep_liveness_repo_error") && String(call[0]).includes("owner/erroring-repo"))).toBe(true);
    countSpy.mockRestore();
  });

  it("logs sweep_liveness_reenqueue_failed and does not throw when the re-enqueue send itself fails", async () => {
    const env = createTestEnv({
      JOBS: {
        async send() {
          throw new Error("queue send error");
        },
      } as unknown as Queue,
    });
    await upsertRepositoryFromGitHub(env, { name: "send-fails", full_name: "owner/send-fails", private: false, owner: { login: "owner" } }, 9305);
    await upsertRepositorySettings(env, { repoFullName: "owner/send-fails", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/send-fails", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runSweepLivenessWatchdog(env)).resolves.toEqual([expect.objectContaining({ repoFullName: "owner/send-fails" })]); // still reported as found even though the re-enqueue itself failed
    expect(errors.mock.calls.some((call) => String(call[0]).includes("sweep_liveness_reenqueue_failed") && String(call[0]).includes("owner/send-fails"))).toBe(true);
  });
});

describe("watchedRepos — per-repo review.sweepWatchdog FORCE-OFF (#6275)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("REGRESSION: an explicit review.sweepWatchdog: false excludes an otherwise-watched, stale repo from the scan entirely", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "opted-out", full_name: "owner/opted-out", private: false, owner: { login: "owner" } }, 9309);
    await upsertRepositorySettings(env, { repoFullName: "owner/opted-out", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/opted-out", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    await upsertRepoFocusManifest(env, "owner/opted-out", { review: { sweepWatchdog: false } });

    const found = await runSweepLivenessWatchdog(env);

    expect(found).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("an explicit review.sweepWatchdog: true is a no-op — the repo is watched exactly as when unset", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "opted-in", full_name: "owner/opted-in", private: false, owner: { login: "owner" } }, 9310);
    await upsertRepositorySettings(env, { repoFullName: "owner/opted-in", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/opted-in", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    await upsertRepoFocusManifest(env, "owner/opted-in", { review: { sweepWatchdog: true } });

    const found = await runSweepLivenessWatchdog(env);

    expect(found).toEqual([expect.objectContaining({ repoFullName: "owner/opted-in" })]);
    expect(sent).toEqual([expect.objectContaining({ repoFullName: "owner/opted-in" })]);
  });

  it("fails OPEN on a manifest-load error — the repo stays watched (a config-read failure must never silently exclude it from monitoring)", async () => {
    const sent: import("../../src/types").JobMessage[] = [];
    const env = createTestEnv({ JOBS: { async send(m: import("../../src/types").JobMessage) { sent.push(m); } } as unknown as Queue });
    await upsertRepositoryFromGitHub(env, { name: "manifest-errors", full_name: "owner/manifest-errors", private: false, owner: { login: "owner" } }, 9311);
    await upsertRepositorySettings(env, { repoFullName: "owner/manifest-errors", autonomy: { merge: "auto" } });
    await upsertPullRequestFromGitHub(env, "owner/manifest-errors", { number: 1, title: "PR1", state: "open", user: { login: "c" }, head: { sha: "a1" }, labels: [], body: "" });
    // resolveRepositorySettings ALSO loads the manifest internally (settings resolution needs it too) -- let
    // that first call succeed normally so this test isolates the SECOND, opt-out-check call (watchedRepos's
    // own explicit loadRepoFocusManifest) as the one that fails.
    const original = focusManifestLoaderModule.loadRepoFocusManifest;
    let callCount = 0;
    vi.spyOn(focusManifestLoaderModule, "loadRepoFocusManifest").mockImplementation(async (...args: Parameters<typeof original>) => {
      callCount += 1;
      if (callCount === 1) return original(...args);
      throw new Error("manifest fetch failed");
    });

    const found = await runSweepLivenessWatchdog(env);

    expect(callCount).toBeGreaterThanOrEqual(2); // both the settings-resolution load AND the opt-out-check load ran
    expect(found).toEqual([expect.objectContaining({ repoFullName: "owner/manifest-errors" })]);
    expect(sent).toEqual([expect.objectContaining({ repoFullName: "owner/manifest-errors" })]);
  });
});
