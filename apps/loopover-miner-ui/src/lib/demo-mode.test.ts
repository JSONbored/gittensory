import { afterEach, describe, expect, it, vi } from "vitest";

import {
  demoFetchPortfolioQueueItems,
  demoRequestAttempt,
  demoRequestDiscover,
  demoStreamChat,
  resetDemoData,
} from "./demo-data";
import { isDemoMode } from "./demo-mode";
import { fetchRunStates } from "./run-history";
import { fetchLedgers } from "./ledgers";
import { fetchPortfolioQueue } from "./portfolio-queue";
import {
  fetchPortfolioQueueItems,
  releasePortfolioQueueItem,
  requeuePortfolioQueueItem,
} from "./portfolio-queue-actions";
import { fetchGovernorPauseState, pauseGovernor, resumeGovernor } from "./governor";
import { requestDiscover } from "./discover";
import { requestAttempt } from "./attempt";
import { streamChat } from "./chat-stream";

describe("demo mode fixtures (#5963)", () => {
  afterEach(() => {
    resetDemoData();
    vi.unstubAllEnvs();
  });

  it("isDemoMode reads VITE_DEMO_MODE", () => {
    vi.stubEnv("VITE_DEMO_MODE", "true");
    expect(isDemoMode()).toBe(true);
    vi.stubEnv("VITE_DEMO_MODE", "");
    expect(isDemoMode()).toBe(false);
  });

  it("serves synthetic run-state / ledger / queue payloads without fetch", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "true");
    const fetchImpl = vi.fn();
    const runs = await fetchRunStates(fetchImpl);
    const ledgers = await fetchLedgers(fetchImpl);
    const queue = await fetchPortfolioQueue(fetchImpl);
    expect(runs.ok && runs.rows.length).toBeGreaterThan(0);
    expect(ledgers.ok && ledgers.summary.claims.total).toBeGreaterThan(0);
    expect(queue.ok && queue.summary.total).toBeGreaterThan(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("mutates governor pause state in memory", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "true");
    expect((await pauseGovernor("demo reason")).ok).toBe(true);
    const paused = await fetchGovernorPauseState();
    expect(paused.ok && paused.pauseState.paused).toBe(true);
    expect(paused.ok && paused.pauseState.reason).toBe("demo reason");
    expect((await resumeGovernor()).ok).toBe(true);
    const resumed = await fetchGovernorPauseState();
    expect(resumed.ok && resumed.pauseState.paused).toBe(false);
  });

  it("release / requeue mutate actionable demo queue items", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "true");
    const before = await fetchPortfolioQueueItems();
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const inProgress = before.items.find((i) => i.status === "in_progress");
    const done = before.items.find((i) => i.status === "done");
    expect(inProgress).toBeTruthy();
    expect(done).toBeTruthy();

    await expect(releasePortfolioQueueItem(inProgress!)).resolves.toMatchObject({
      ok: true,
      entry: { status: "queued" },
    });
    const afterRelease = await fetchPortfolioQueueItems();
    expect(afterRelease.ok && afterRelease.items.every((i) => i.status !== "in_progress")).toBe(true);
    await expect(releasePortfolioQueueItem(inProgress!)).resolves.toMatchObject({ ok: false });

    resetDemoData();
    const seeded = demoFetchPortfolioQueueItems();
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;
    const doneAgain = seeded.items.find((i) => i.status === "done")!;
    await expect(requeuePortfolioQueueItem(doneAgain)).resolves.toMatchObject({ ok: true });
    await expect(requeuePortfolioQueueItem(doneAgain)).resolves.toMatchObject({ ok: false });
  });

  it("discover / attempt / chat return canned demo results", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "true");
    await expect(requestDiscover({ dryRun: true })).resolves.toMatchObject({ ok: true, exitCode: 0 });
    await expect(
      requestAttempt({ repoFullName: "demo-org/sample-widgets", issueNumber: 1, minerLogin: "demo" }),
    ).resolves.toMatchObject({ ok: true, exitCode: 0 });
    expect(demoRequestDiscover({}).ok).toBe(true);
    expect(demoRequestAttempt({ repoFullName: "a/b", issueNumber: 1, minerLogin: "x" }).ok).toBe(true);

    const chunks: string[] = [];
    for await (const chunk of streamChat([{ role: "user", content: "hi" }], vi.fn())) {
      chunks.push(chunk);
    }
    expect(chunks.join("")).toContain("synthetic sample data");
    const demoChunks: string[] = [];
    for await (const chunk of demoStreamChat()) demoChunks.push(chunk);
    expect(demoChunks.join("")).toEqual(chunks.join(""));
  });
});
