import { describe, expect, it } from "vitest";
import { buildMaintainerQueueHealthCard, readQueueHealthSignals } from "../../src/services/maintainer-queue-health-card";
import type { SignalSnapshotRecord } from "../../src/types";

function snapshot(generatedAt: string, openPullRequests: number, stalePullRequests = 0, likelyReviewable = 0): SignalSnapshotRecord {
  return {
    id: `${generatedAt}-${openPullRequests}`,
    signalType: "queue-health",
    targetKey: "octo/demo",
    repoFullName: "octo/demo",
    generatedAt,
    payload: {
      signals: {
        openPullRequests,
        stalePullRequests,
        likelyReviewablePullRequests: likelyReviewable,
        collisionClusters: 0,
      },
    },
  };
}

describe("buildMaintainerQueueHealthCard (#2201)", () => {
  it("aggregates pending/in-flight/stuck counts and queue-depth trend from cached snapshots", () => {
    const card = buildMaintainerQueueHealthCard({
      generatedAt: "2026-07-10T12:00:00.000Z",
      stale: false,
      histories: [[snapshot("2026-07-10T12:00:00.000Z", 5, 1, 2), snapshot("2026-07-08T12:00:00.000Z", 2)]],
      highRiskDuplicates: 0,
    });
    expect(card).toMatchObject({ pending: 5, inFlight: 2, stuck: 1, dlq: 0, stale: false });
    expect(card.queueDepthTrend).toEqual([2, 5]);
  });

  it("reports DLQ pressure from high-risk duplicate clusters", () => {
    const card = buildMaintainerQueueHealthCard({
      generatedAt: "2026-07-10T12:00:00.000Z",
      stale: false,
      histories: [[snapshot("2026-07-10T12:00:00.000Z", 3)]],
      highRiskDuplicates: 2,
    });
    expect(card.dlq).toBe(2);
    expect(card.summary).toContain("high-risk duplicate");
  });

  it("carries the stale flag through to the card payload", () => {
    const card = buildMaintainerQueueHealthCard({
      generatedAt: "2026-07-10T12:00:00.000Z",
      stale: true,
      histories: [],
      highRiskDuplicates: 0,
    });
    expect(card.stale).toBe(true);
    expect(card.pending).toBe(0);
  });
});

describe("readQueueHealthSignals", () => {
  it("returns null when the payload has no queue-health signals block", () => {
    expect(readQueueHealthSignals({})).toBeNull();
    expect(readQueueHealthSignals({ signals: [] })).toBeNull();
  });

  it("coerces missing or non-numeric signal fields to zero", () => {
    expect(readQueueHealthSignals({ signals: { openPullRequests: "4" } })).toMatchObject({
      openPullRequests: 0,
      stalePullRequests: 0,
      likelyReviewablePullRequests: 0,
      collisionClusters: 0,
    });
  });
});

describe("buildMaintainerQueueHealthCard edge cases", () => {
  it("skips histories with invalid payloads and caps the trend series", () => {
    const histories = [
      Array.from({ length: 16 }, (_, index) =>
        snapshot(`2026-07-02T${String(index).padStart(2, "0")}:00:00.000Z`, index + 1),
      ).reverse(),
      [{ ...snapshot("2026-07-01T01:00:00.000Z", 99), payload: {} }],
    ];
    const card = buildMaintainerQueueHealthCard({
      generatedAt: "2026-07-10T12:00:00.000Z",
      stale: false,
      histories,
      highRiskDuplicates: 0,
    });
    expect(card.pending).toBe(16);
    expect(card.queueDepthTrend.length).toBeLessThanOrEqual(14);
  });

  it("uses the non-clear summary when any queue pressure remains", () => {
    const card = buildMaintainerQueueHealthCard({
      generatedAt: "2026-07-10T12:00:00.000Z",
      stale: false,
      histories: [[snapshot("2026-07-10T12:00:00.000Z", 2, 1, 0)]],
      highRiskDuplicates: 0,
    });
    expect(card.summary).toContain("open PR(s)");
  });

  it("skips trend rows when generatedAt is missing", () => {
    const card = buildMaintainerQueueHealthCard({
      generatedAt: "2026-07-10T12:00:00.000Z",
      stale: false,
      histories: [[{ ...snapshot("2026-07-10T12:00:00.000Z", 4), generatedAt: undefined }]],
      highRiskDuplicates: 0,
    });
    expect(card.queueDepthTrend).toEqual([]);
    expect(card.pending).toBe(4);
  });
});
