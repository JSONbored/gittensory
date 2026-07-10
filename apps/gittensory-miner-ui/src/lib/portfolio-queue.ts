// Read-only client for the local portfolio-queue API (#4306). The view only needs summary cards, so the
// middleware returns pre-aggregated counts and never republishes raw queue identifiers or priority metadata.

export const PORTFOLIO_QUEUE_API_PATH = "/api/portfolio-queue";

export const QUEUE_STATUSES = ["queued", "in_progress", "done"] as const;

export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export type QueueStatusCounts = Record<QueueStatus, number>;

export type PortfolioQueueSummary = {
  total: number;
  counts: QueueStatusCounts;
};

export type PortfolioQueueResult = { ok: true; summary: PortfolioQueueSummary } | { ok: false; error: string };

function isQueueStatusCounts(value: unknown): value is QueueStatusCounts {
  if (typeof value !== "object" || value === null) return false;
  const counts = value as Record<string, unknown>;
  return QUEUE_STATUSES.every((status) => typeof counts[status] === "number");
}

function isPortfolioQueueSummary(value: unknown): value is PortfolioQueueSummary {
  if (typeof value !== "object" || value === null) return false;
  const summary = value as Record<string, unknown>;
  return typeof summary.total === "number" && isQueueStatusCounts(summary.counts);
}

export const emptyPortfolioQueueSummary = (): PortfolioQueueSummary => ({
  total: 0,
  counts: { queued: 0, in_progress: 0, done: 0 },
});

export function summarizePortfolioQueueStatuses(statuses: QueueStatus[]): PortfolioQueueSummary {
  const summary = emptyPortfolioQueueSummary();
  for (const status of statuses) {
    summary.total += 1;
    summary.counts[status] += 1;
  }
  return summary;
}

/** Fetch the local queue summary; failures surface as a typed error result the view renders, never a crash. */
export async function fetchPortfolioQueue(fetchImpl: typeof fetch = fetch): Promise<PortfolioQueueResult> {
  try {
    const response = await fetchImpl(PORTFOLIO_QUEUE_API_PATH);
    if (!response.ok) return { ok: false, error: `local portfolio-queue API responded ${response.status}` };
    const payload: unknown = await response.json();
    const summary = (payload as { summary?: unknown }).summary;
    if (!isPortfolioQueueSummary(summary)) {
      return { ok: false, error: "local portfolio-queue API returned an unexpected payload shape" };
    }
    return { ok: true, summary };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "failed to reach the local portfolio-queue API",
    };
  }
}
