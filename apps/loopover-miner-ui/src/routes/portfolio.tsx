import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@loopover/ui-kit/components/button";
import { Card, CardContent, CardHeader } from "@loopover/ui-kit/components/card";
import { Skeleton } from "@loopover/ui-kit/components/skeleton";
import { StateBoundary } from "@loopover/ui-kit/components/state-views";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@loopover/ui-kit/components/table";

import {
  fetchPortfolioQueueItems,
  requeuePortfolioQueueItem,
  releasePortfolioQueueItem,
  type PortfolioQueueActionItem,
  type PortfolioQueueActionResult,
  type PortfolioQueueItemsResult,
} from "../lib/portfolio-queue-actions";
import { DEFAULT_POLL_INTERVAL_MS, usePolledFetch } from "../lib/use-polled-fetch";
import { fetchPortfolioQueue, type PortfolioQueueResult, type QueueStatus } from "../lib/portfolio-queue";

export const Route = createFileRoute("/portfolio")({
  component: PortfolioPage,
});

// Portfolio/queue summary cards + per-repo table (#4306, reunified with the CLI's own richer `queue dashboard`
// by #4846), plus release/requeue controls (#4857) backed by the same store methods the CLI uses.

const STATUS_LABELS: Record<QueueStatus, string> = {
  queued: "Queued",
  in_progress: "In progress",
  done: "Done",
};

const STATUS_TONE: Record<QueueStatus, string> = {
  queued: "text-muted-foreground",
  in_progress: "text-warning",
  done: "text-success",
};

/** Placeholder shaped like the real summary -- three status cards over the repo table -- so the layout doesn't
 *  jump when the 10s poll lands. A single generic bar would just move the jump later. */
function PortfolioQueueSkeleton() {
  return (
    <div className="grid gap-6" data-testid="portfolio-queue-skeleton">
      <dl className="grid gap-4 sm:grid-cols-3">
        {(Object.keys(STATUS_LABELS) as QueueStatus[]).map((status) => (
          <Card key={status}>
            <CardContent className="p-4">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-2 h-8 w-12" />
            </CardContent>
          </Card>
        ))}
      </dl>
      <div className="grid gap-2">
        {[0, 1, 2].map((row) => (
          <Skeleton key={`repo-row-${row}`} className="h-8 w-full" />
        ))}
      </div>
    </div>
  );
}

export function PortfolioQueueView({ result }: { result: PortfolioQueueResult | null }) {
  const summary = result?.ok ? result.summary : null;
  return (
    <StateBoundary
      isLoading={result === null}
      isError={result !== null && !result.ok}
      isEmpty={summary !== null && summary.total === 0}
      loadingSkeleton={<PortfolioQueueSkeleton />}
      // Each message is passed as the WHOLE original sentence with the description suppressed, rather than
      // split across title/description: the issue requires the user-visible strings not be reworded, and Shell
      // renders `{description && ...}` so an empty one adds nothing. The rendered text is byte-identical to the
      // <p> tags this replaces. ErrorState emits role="alert" itself, so failures still announce the same way.
      errorTitle={
        result !== null && !result.ok ? `Could not read the local portfolio queue: ${result.error}` : undefined
      }
      errorDescription=""
      emptyTitle="No queued work yet — the cards fill in once the miner enqueues its first portfolio item."
      emptyDescription={null}
    >
      {summary === null ? null : (
        <div className="grid gap-6">
          <dl className="grid gap-4 sm:grid-cols-3">
            {(Object.keys(STATUS_LABELS) as QueueStatus[]).map((status) => (
              <Card key={status}>
                <CardContent className="p-4">
                  <dt className="text-token-2xs uppercase tracking-wider text-muted-foreground">
                    {STATUS_LABELS[status]}
                  </dt>
                  <dd className={`mt-1 text-token-3xl font-display font-semibold ${STATUS_TONE[status]}`}>
                    {summary.byStatus[status]}
                  </dd>
                </CardContent>
              </Card>
            ))}
          </dl>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Repository</TableHead>
                <TableHead>Queued</TableHead>
                <TableHead>In progress</TableHead>
                <TableHead>Done</TableHead>
                <TableHead>Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.repos.map((repo) => (
                <TableRow key={repo.repoFullName}>
                  <TableCell className="font-mono text-foreground">{repo.repoFullName}</TableCell>
                  <TableCell>{repo.byStatus.queued}</TableCell>
                  <TableCell>{repo.byStatus.in_progress}</TableCell>
                  <TableCell>{repo.byStatus.done}</TableCell>
                  <TableCell>{repo.total}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </StateBoundary>
  );
}

/** Placeholder shaped like the queue-actions table's rows, for the same reason as the summary's. */
function QueueActionsSkeleton() {
  return (
    <div className="grid gap-2" data-testid="queue-actions-skeleton">
      {[0, 1, 2].map((row) => (
        <Skeleton key={`action-row-${row}`} className="h-8 w-full" />
      ))}
    </div>
  );
}

export function PortfolioQueueActionsSection({
  result,
  actionResult,
  pending,
  onRelease,
  onRequeue,
}: {
  result: PortfolioQueueItemsResult | null;
  actionResult: PortfolioQueueActionResult | null;
  pending: boolean;
  onRelease: (item: PortfolioQueueActionItem) => void;
  onRequeue: (item: PortfolioQueueActionItem) => void;
}) {
  return (
    <section className="grid gap-3">
      <h3 className="font-display text-token-base font-semibold">Queue actions</h3>
      {actionResult !== null && !actionResult.ok ? (
        <p role="alert" className="text-token-sm text-danger">
          Queue action failed: {actionResult.error}
        </p>
      ) : null}
      {/* Its own boundary, deliberately: this fetch is independent of the summary above, so a failure here
          must not blank the summary -- and a summary failure must not hide the actions. Same whole-sentence
          treatment as above, so the empty/error copy stays byte-identical to the <p> tags it replaces. */}
      <StateBoundary
        isLoading={result === null}
        isError={result !== null && !result.ok}
        isEmpty={result !== null && result.ok && result.items.length === 0}
        loadingSkeleton={<QueueActionsSkeleton />}
        errorTitle={
          result !== null && !result.ok ? `Could not read actionable queue items: ${result.error}` : undefined
        }
        errorDescription=""
        emptyTitle="No in-progress or completed items to release or requeue right now."
        emptyDescription={null}
      >
        {result === null || !result.ok || result.items.length === 0 ? null : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Repository</TableHead>
                <TableHead>Identifier</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.items.map((item) => (
                <TableRow key={`${item.apiBaseUrl}:${item.repoFullName}:${item.identifier}`}>
                  <TableCell className="font-mono text-foreground">{item.repoFullName}</TableCell>
                  <TableCell className="font-mono">{item.identifier}</TableCell>
                  <TableCell>{STATUS_LABELS[item.status]}</TableCell>
                  <TableCell>
                    {item.status === "in_progress" ? (
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => onRelease(item)}>
                        Release
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => onRequeue(item)}>
                        Requeue
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </StateBoundary>
    </section>
  );
}

export function PortfolioPage({
  loadPortfolioQueue = fetchPortfolioQueue,
  loadPortfolioQueueItems = fetchPortfolioQueueItems,
  releaseItem = releasePortfolioQueueItem,
  requeueItem = requeuePortfolioQueueItem,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: {
  loadPortfolioQueue?: () => Promise<PortfolioQueueResult>;
  loadPortfolioQueueItems?: () => Promise<PortfolioQueueItemsResult>;
  releaseItem?: typeof releasePortfolioQueueItem;
  requeueItem?: typeof requeuePortfolioQueueItem;
  pollIntervalMs?: number;
}) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [actionPending, setActionPending] = useState(false);
  const [itemsResult, setItemsResult] = useState<PortfolioQueueItemsResult | null>(null);
  const [actionResult, setActionResult] = useState<PortfolioQueueActionResult | null>(null);

  const loadSummary = useCallback(() => loadPortfolioQueue(), [loadPortfolioQueue, refreshKey]);
  const summaryResult = usePolledFetch(loadSummary, pollIntervalMs);

  const refreshItems = useCallback(() => {
    void loadPortfolioQueueItems().then(setItemsResult);
  }, [loadPortfolioQueueItems, refreshKey]);

  useEffect(() => {
    refreshItems();
  }, [refreshItems]);

  const runQueueAction = (action: () => Promise<PortfolioQueueActionResult>) => {
    setActionPending(true);
    void action().then((next) => {
      setActionResult(next);
      if (next.ok) {
        setRefreshKey((key) => key + 1);
        refreshItems();
      }
      setActionPending(false);
    });
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="font-display text-token-lg font-semibold">Portfolio queue</h2>
        <p className="text-token-sm text-muted-foreground">
          Local summary and controls for the miner&apos;s portfolio queue (`miner_portfolio_queue`).
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6">
          <PortfolioQueueView result={summaryResult} />
          <PortfolioQueueActionsSection
            result={itemsResult}
            actionResult={actionResult}
            pending={actionPending}
            onRelease={(item) => runQueueAction(() => releaseItem(item))}
            onRequeue={(item) => runQueueAction(() => requeueItem(item))}
          />
        </div>
      </CardContent>
    </Card>
  );
}
