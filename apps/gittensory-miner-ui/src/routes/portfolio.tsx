import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { fetchPortfolioQueue, type PortfolioQueueResult, type QueueStatus } from "../lib/portfolio-queue";

export const Route = createFileRoute("/portfolio")({
  component: PortfolioPage,
});

// Portfolio/queue summary cards (#4306): read-only counts by status over the local `miner_portfolio_queue`
// store. Same 4-state pattern as the run-history view (loading / error / fresh-install empty / populated).

const STATUS_LABELS: Record<QueueStatus, string> = {
  queued: "Queued",
  in_progress: "In progress",
  done: "Done",
};

const STATUS_CARD_CLASSES: Record<QueueStatus, string> = {
  queued: "border-sky-400/30 bg-sky-500/10 text-sky-100",
  in_progress: "border-amber-400/30 bg-amber-500/10 text-amber-100",
  done: "border-emerald-400/30 bg-emerald-500/10 text-emerald-100",
};

export function PortfolioQueueView({ result }: { result: PortfolioQueueResult | null }) {
  if (result === null) {
    return <p className="text-sm text-white/60">Loading local portfolio queue…</p>;
  }
  if (!result.ok) {
    return (
      <p role="alert" className="text-sm text-rose-300">
        Could not read the local portfolio queue: {result.error}
      </p>
    );
  }
  const summary = result.summary;
  if (summary.total === 0) {
    return (
      <p className="text-sm text-white/60">
        No queued work yet — the cards fill in once the miner enqueues its first portfolio item.
      </p>
    );
  }
  return (
    <div>
      <dl className="grid gap-4 sm:grid-cols-3">
        {(Object.keys(STATUS_LABELS) as QueueStatus[]).map((status) => (
          <div key={status} className={`rounded-xl border p-4 ${STATUS_CARD_CLASSES[status]}`}>
            <dt className="text-xs uppercase tracking-wider opacity-80">{STATUS_LABELS[status]}</dt>
            <dd className="mt-1 text-3xl font-semibold">{summary.counts[status]}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function PortfolioPage({
  loadPortfolioQueue = fetchPortfolioQueue,
}: {
  loadPortfolioQueue?: () => Promise<PortfolioQueueResult>;
}) {
  const [result, setResult] = useState<PortfolioQueueResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadPortfolioQueue().then((loaded) => {
      if (!cancelled) setResult(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [loadPortfolioQueue]);

  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-6">
      <h2 className="text-xl font-semibold">Portfolio queue</h2>
      <p className="mt-1 text-sm text-white/60">
        Local, read-only summary of the miner&apos;s portfolio queue (`miner_portfolio_queue`).
      </p>
      <div className="mt-4">
        <PortfolioQueueView result={result} />
      </div>
    </section>
  );
}
