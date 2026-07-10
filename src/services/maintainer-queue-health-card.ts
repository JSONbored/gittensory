// Maintainer queue-health trend card (#2201): shapes cached queue-health signal snapshots into the
// read-only card payload the maintainer dashboard renders. Counts are aggregate-only — no actor logins,
// burden scores, or reward fields.
import type { JsonValue, SignalSnapshotRecord } from "../types";

export type MaintainerQueueHealthCard = {
  generatedAt: string;
  stale: boolean;
  pending: number;
  inFlight: number;
  stuck: number;
  dlq: number;
  queueDepthTrend: number[];
  summary: string;
};

const TREND_POINT_LIMIT = 14;

type QueueHealthSignals = {
  openPullRequests: number;
  stalePullRequests: number;
  likelyReviewablePullRequests: number;
  collisionClusters: number;
};

export function readQueueHealthSignals(payload: Record<string, JsonValue>): QueueHealthSignals | null {
  const signals = payload.signals;
  if (!signals || typeof signals !== "object" || Array.isArray(signals)) return null;
  const record = signals as Record<string, JsonValue>;
  return {
    openPullRequests: numberValue(record.openPullRequests),
    stalePullRequests: numberValue(record.stalePullRequests),
    likelyReviewablePullRequests: numberValue(record.likelyReviewablePullRequests),
    collisionClusters: numberValue(record.collisionClusters),
  };
}

/** Fold cached queue-health snapshots + duplicate-risk totals into the maintainer card payload. */
export function buildMaintainerQueueHealthCard(args: {
  generatedAt: string;
  stale: boolean;
  histories: readonly (readonly SignalSnapshotRecord[])[];
  highRiskDuplicates: number;
}): MaintainerQueueHealthCard {
  const latestByRepo = args.histories.map((history) => history[0] ?? null).filter((row): row is SignalSnapshotRecord => row !== null);
  const latestSignals = latestByRepo
    .map((row) => readQueueHealthSignals(row.payload))
    .filter((signals): signals is QueueHealthSignals => signals !== null);

  const pending = latestSignals.reduce((sum, signals) => sum + signals.openPullRequests, 0);
  const inFlight = latestSignals.reduce((sum, signals) => sum + signals.likelyReviewablePullRequests, 0);
  const stuck = latestSignals.reduce((sum, signals) => sum + signals.stalePullRequests, 0);
  const dlq = args.highRiskDuplicates;

  const trendBuckets = new Map<string, number>();
  for (const history of args.histories) {
    for (const row of history) {
      const signals = readQueueHealthSignals(row.payload);
      if (!signals) continue;
      const bucket = row.generatedAt?.slice(0, 13);
      if (!bucket) continue;
      trendBuckets.set(bucket, (trendBuckets.get(bucket) ?? 0) + signals.openPullRequests);
    }
  }
  const queueDepthTrend = [...trendBuckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value)
    .slice(-TREND_POINT_LIMIT);

  const summary =
    pending === 0 && stuck === 0 && dlq === 0
      ? "Queue health looks clear across shaped repos."
      : `${pending} open PR(s), ${stuck} stale, ${dlq} high-risk duplicate cluster(s) across shaped repos.`;

  return {
    generatedAt: args.generatedAt,
    stale: args.stale,
    pending,
    inFlight,
    stuck,
    dlq,
    queueDepthTrend,
    summary,
  };
}

function numberValue(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
