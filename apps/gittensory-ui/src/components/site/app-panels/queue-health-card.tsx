import { AnalyticsCardShell } from "@/components/site/app-panels/analytics-card-shell";
import { Stat, StatusPill, type Status } from "@/components/site/control-primitives";
import { cn } from "@/lib/utils";

/** Aggregate PR-queue-health for the maintainer quality dashboard (#2201): summed open/stale/draft/unlinked PR
 *  counts across the maintainer's shaped repos, an age-bucket distribution, and how many repos fall in each
 *  burden band. Display slice over the dashboard payload's `queueHealth` aggregate — counts + bands, never raw
 *  scores. Degrades to an empty state when the field is absent or the queue is empty. */
export type MaintainerQueueHealth = {
  openPullRequests: number;
  stalePullRequests: number;
  draftPullRequests: number;
  unlinkedPullRequests: number;
  collisionClusters: number;
  ageBuckets: { under7Days: number; days7To30: number; over30Days: number };
  bandCounts: { low: number; medium: number; high: number; critical: number };
};

const BAND_STATUS: Record<keyof MaintainerQueueHealth["bandCounts"], Status> = {
  low: "ready",
  medium: "info",
  high: "warn",
  critical: "degraded",
};

const BAND_ORDER: Array<keyof MaintainerQueueHealth["bandCounts"]> = [
  "low",
  "medium",
  "high",
  "critical",
];

const AGE_BAR: Record<keyof MaintainerQueueHealth["ageBuckets"], string> = {
  under7Days: "bg-success",
  days7To30: "bg-warning",
  over30Days: "bg-danger",
};

const AGE_LABEL: Record<keyof MaintainerQueueHealth["ageBuckets"], string> = {
  under7Days: "< 7d",
  days7To30: "7–30d",
  over30Days: "> 30d",
};

export function QueueHealthCard({ queueHealth }: { queueHealth?: MaintainerQueueHealth }) {
  if (!queueHealth || queueHealth.openPullRequests === 0) {
    return (
      <AnalyticsCardShell
        title="Queue health"
        description="Open / stale / draft / unlinked PRs across your repos, by age and burden band."
        state="empty"
        emptyTitle={queueHealth ? "Queue is clear" : "Not yet available"}
        emptyHint={
          queueHealth
            ? "No open pull requests across the shaped repos in this window."
            : "Queue health appears once the maintainer dashboard payload includes the queue aggregate."
        }
      />
    );
  }

  const { openPullRequests, stalePullRequests, draftPullRequests, unlinkedPullRequests } =
    queueHealth;
  const ageTotal =
    queueHealth.ageBuckets.under7Days +
    queueHealth.ageBuckets.days7To30 +
    queueHealth.ageBuckets.over30Days;

  return (
    <AnalyticsCardShell
      title="Queue health"
      description="Open / stale / draft / unlinked PRs across your repos, by age and burden band."
      state="ready"
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Open PRs" value={String(openPullRequests)} />
        <Stat label="Stale" value={String(stalePullRequests)} />
        <Stat label="Draft" value={String(draftPullRequests)} />
        <Stat label="Unlinked" value={String(unlinkedPullRequests)} />
      </div>

      <div className="mt-4 space-y-1.5">
        <div className="flex items-center justify-between text-token-xs text-muted-foreground">
          <span>Open-PR age</span>
          <span className="font-mono">{queueHealth.collisionClusters} collision cluster(s)</span>
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-border" aria-hidden>
          {ageTotal > 0
            ? (Object.keys(AGE_BAR) as Array<keyof MaintainerQueueHealth["ageBuckets"]>)
                .filter((bucket) => queueHealth.ageBuckets[bucket] > 0)
                .map((bucket) => (
                  <div
                    key={bucket}
                    className={cn("h-full", AGE_BAR[bucket])}
                    style={{ width: `${(queueHealth.ageBuckets[bucket] / ageTotal) * 100}%` }}
                  />
                ))
            : null}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-token-2xs text-muted-foreground">
          {(Object.keys(AGE_LABEL) as Array<keyof MaintainerQueueHealth["ageBuckets"]>).map(
            (bucket) => (
              <span key={bucket}>
                {AGE_LABEL[bucket]} {queueHealth.ageBuckets[bucket]}
              </span>
            ),
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {BAND_ORDER.filter((band) => queueHealth.bandCounts[band] > 0).map((band) => (
          <StatusPill key={band} status={BAND_STATUS[band]}>
            {band} {queueHealth.bandCounts[band]}
          </StatusPill>
        ))}
      </div>
    </AnalyticsCardShell>
  );
}
