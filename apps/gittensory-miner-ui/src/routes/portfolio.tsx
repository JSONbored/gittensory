import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@loopover/ui-kit/components/button";
import { Card, CardContent, CardHeader } from "@loopover/ui-kit/components/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@loopover/ui-kit/components/table";

import { DEFAULT_POLL_INTERVAL_MS, usePolledFetch } from "../lib/use-polled-fetch";
import { fetchPortfolioQueue, type PortfolioQueueResult, type QueueStatus } from "../lib/portfolio-queue";
import {
  fetchQueueActionable,
  releaseQueueItem,
  requeueQueueItem,
  type QueueActionableResult,
  type QueueActionResult,
  type ReleasableItem,
  type RequeueableItem,
} from "../lib/queue-actions";

export const Route = createFileRoute("/portfolio")({
  component: PortfolioPage,
});

// Portfolio/queue summary cards + per-repo table (#4306, reunified with the CLI's own richer `queue dashboard`
// by #4846): read-only counts by status over the local `miner_portfolio_queue` store, now broken out per repo
// exactly as `gittensory-miner queue dashboard` already shows -- the miner-ui no longer maintains a narrower,
// global-only aggregation. Same 4-state pattern as the run-history view (loading / error / fresh-install empty
// / populated).
//
// The queue-actions section below is a SEPARATE fetch/action loop from the read-only summary above (#4857, the
// queue half): it lists ONLY the in-flight/completed items an operator can act on and lets them
// release/requeue via vite-queue-actions-api.ts, mirroring the governor pause/resume control section on the
// ledgers page. Each row tracks its own pending state (a `Set` of item keys) rather than one global flag, since
// multiple different rows can plausibly be acted on independently.

const STATUS_LABELS: Record<QueueStatus, string> = {
  queued: "Queued",
  in_progress: "In progress",
  done: "Done",
};

// Semantic tone per status, sourced from the shared design system's success/warning
// tokens rather than arbitrary color utilities — kept separate from the accent hue.
const STATUS_TONE: Record<QueueStatus, string> = {
  queued: "text-muted-foreground",
  in_progress: "text-[var(--warning)]",
  done: "text-[var(--success)]",
};

export function PortfolioQueueView({ result }: { result: PortfolioQueueResult | null }) {
  if (result === null) {
    return <p className="text-token-sm text-muted-foreground">Loading local portfolio queue…</p>;
  }
  if (!result.ok) {
    return (
      <p role="alert" className="text-token-sm text-[var(--danger)]">
        Could not read the local portfolio queue: {result.error}
      </p>
    );
  }
  const summary = result.summary;
  if (summary.total === 0) {
    return (
      <p className="text-token-sm text-muted-foreground">
        No queued work yet — the cards fill in once the miner enqueues its first portfolio item.
      </p>
    );
  }
  return (
    <div className="grid gap-6">
      <dl className="grid gap-4 sm:grid-cols-3">
        {(Object.keys(STATUS_LABELS) as QueueStatus[]).map((status) => (
          <Card key={status}>
            <CardContent className="p-4">
              <dt className="text-token-2xs uppercase tracking-wider text-muted-foreground">{STATUS_LABELS[status]}</dt>
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
  );
}

/** Stable identity for an actionable item across the read snapshot and the pending-action tracking `Set` —
 *  exported so tests can assert on it directly instead of re-deriving the same string inline. */
export function queueItemKey(item: { apiBaseUrl: string; repoFullName: string; identifier: string }): string {
  return `${item.apiBaseUrl}|${item.repoFullName}|${item.identifier}`;
}

export function QueueActionsSection({
  result,
  pendingKeys,
  actionError,
  onRelease,
  onRequeue,
}: {
  result: QueueActionableResult | null;
  pendingKeys: Set<string>;
  actionError: string | null;
  onRelease: (item: ReleasableItem) => void;
  onRequeue: (item: RequeueableItem) => void;
}) {
  return (
    <section className="grid gap-4">
      <h3 className="font-display text-token-base font-semibold">Queue actions</h3>
      {actionError !== null && (
        <p role="alert" className="text-token-sm text-[var(--danger)]">
          Action failed: {actionError}
        </p>
      )}
      {result === null ? (
        <p className="text-token-sm text-muted-foreground">Loading actionable queue items…</p>
      ) : !result.ok ? (
        <p role="alert" className="text-token-sm text-[var(--danger)]">
          Could not read actionable queue items: {result.error}
        </p>
      ) : result.releasable.length === 0 && result.requeueable.length === 0 ? (
        <p className="text-token-sm text-muted-foreground">No in-progress or completed items to act on right now.</p>
      ) : (
        <div className="grid gap-6">
          {result.releasable.length > 0 && (
            <div className="grid gap-2">
              <h4 className="text-token-sm font-semibold text-muted-foreground">In progress (releasable)</h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Repository</TableHead>
                    <TableHead>Identifier</TableHead>
                    <TableHead>Leased</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.releasable.map((item) => {
                    const key = queueItemKey(item);
                    return (
                      <TableRow key={key}>
                        <TableCell className="font-mono text-foreground">{item.repoFullName}</TableCell>
                        <TableCell className="font-mono">{item.identifier}</TableCell>
                        <TableCell>{item.leasedAt ?? "—"}</TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pendingKeys.has(key)}
                            onClick={() => onRelease(item)}
                          >
                            Release
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          {result.requeueable.length > 0 && (
            <div className="grid gap-2">
              <h4 className="text-token-sm font-semibold text-muted-foreground">Done (requeueable)</h4>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Repository</TableHead>
                    <TableHead>Identifier</TableHead>
                    <TableHead>Enqueued</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.requeueable.map((item) => {
                    const key = queueItemKey(item);
                    return (
                      <TableRow key={key}>
                        <TableCell className="font-mono text-foreground">{item.repoFullName}</TableCell>
                        <TableCell className="font-mono">{item.identifier}</TableCell>
                        <TableCell>{item.enqueuedAt}</TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={pendingKeys.has(key)}
                            onClick={() => onRequeue(item)}
                          >
                            Requeue
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function PortfolioPage({
  loadPortfolioQueue = fetchPortfolioQueue,
  loadQueueActionable = fetchQueueActionable,
  releaseAction = releaseQueueItem,
  requeueAction = requeueQueueItem,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: {
  loadPortfolioQueue?: () => Promise<PortfolioQueueResult>;
  loadQueueActionable?: () => Promise<QueueActionableResult>;
  releaseAction?: (item: ReleasableItem) => Promise<QueueActionResult>;
  requeueAction?: (item: RequeueableItem) => Promise<QueueActionResult>;
  pollIntervalMs?: number;
}) {
  const result = usePolledFetch(loadPortfolioQueue, pollIntervalMs);
  const [actionableResult, setActionableResult] = useState<QueueActionableResult | null>(null);
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshActionable = useCallback(() => {
    void loadQueueActionable().then(setActionableResult);
  }, [loadQueueActionable]);

  useEffect(() => {
    refreshActionable();
  }, [refreshActionable]);

  const runAction = <T extends ReleasableItem | RequeueableItem>(
    item: T,
    action: (item: T) => Promise<QueueActionResult>,
  ) => {
    const key = queueItemKey(item);
    setActionError(null);
    setPendingKeys((prev) => new Set(prev).add(key));
    void action(item).then((outcome) => {
      setPendingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
      if (!outcome.ok) {
        setActionError(outcome.error);
        return;
      }
      refreshActionable();
    });
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="font-display text-token-lg font-semibold">Portfolio queue</h2>
        <p className="text-token-sm text-muted-foreground">
          Local, read-only summary of the miner&apos;s portfolio queue (`miner_portfolio_queue`).
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6">
          <PortfolioQueueView result={result} />
          <QueueActionsSection
            result={actionableResult}
            pendingKeys={pendingKeys}
            actionError={actionError}
            onRelease={(item) => runAction(item, releaseAction)}
            onRequeue={(item) => runAction(item, requeueAction)}
          />
        </div>
      </CardContent>
    </Card>
  );
}
