import { existsSync } from "node:fs";
import type { Plugin } from "vite";

// Local read-only portfolio-queue API (#4306) — the sibling of `vite-run-state-api.ts` (#4305), same shape for
// the same reason: the dashboard is a browser app while the queue store is a `node:sqlite` file on disk, so the
// dev server bridges the two by calling into `packages/gittensory-miner/lib/portfolio-queue.js`'s EXISTING
// exports (`resolvePortfolioQueueDbPath`/`listQueue`). It aggregates server-side so the HTTP surface never
// republishes raw queue identifiers or rank-derived priorities.
//
// Same read-only fresh-install rule as the run-state endpoint: `listQueue()` lazily initializes the default
// store, which would CREATE the SQLite file — so the handler probes the resolved DB path first and serves an
// empty summary without ever touching the store when no DB exists yet.

type PortfolioQueueModule = {
  resolvePortfolioQueueDbPath: () => string;
  listQueue: () => Array<{ status: string }>;
};

export type PortfolioQueueApiDeps = {
  /** Import of `packages/gittensory-miner/lib/portfolio-queue.js` — injectable so tests never touch a real store. */
  loadPortfolioQueueModule: () => Promise<PortfolioQueueModule>;
  /** File-existence probe for the fresh-install fast path. */
  fileExists: (path: string) => boolean;
};

type QueueStatus = "queued" | "in_progress" | "done";
type QueueStatusCounts = Record<QueueStatus, number>;
type PortfolioQueueSummary = { total: number; counts: QueueStatusCounts };

const QUEUE_STATUSES = ["queued", "in_progress", "done"] as const;

function emptyPortfolioQueueSummary(): PortfolioQueueSummary {
  return { total: 0, counts: { queued: 0, in_progress: 0, done: 0 } };
}

function isQueueStatus(value: string): value is QueueStatus {
  return (QUEUE_STATUSES as readonly string[]).includes(value);
}

function summarizePortfolioQueueRows(rows: Array<{ status: string }>): PortfolioQueueSummary {
  const summary = emptyPortfolioQueueSummary();
  for (const row of rows) {
    if (!isQueueStatus(row.status)) continue;
    summary.total += 1;
    summary.counts[row.status] += 1;
  }
  return summary;
}

const defaultDeps: PortfolioQueueApiDeps = {
  loadPortfolioQueueModule: () =>
    import("../../packages/gittensory-miner/lib/portfolio-queue.js") as Promise<PortfolioQueueModule>,
  fileExists: existsSync,
};

/** Request handler factored out of the Vite plugin shape so tests drive it directly (mirrors the run-state API). */
export async function handlePortfolioQueueRequest(
  method: string | undefined,
  url: string | undefined,
  deps: PortfolioQueueApiDeps = defaultDeps,
): Promise<{ status: number; body: string } | null> {
  if (url !== "/api/portfolio-queue" || (method !== undefined && method !== "GET")) return null;
  try {
    const queue = await deps.loadPortfolioQueueModule();
    if (!deps.fileExists(queue.resolvePortfolioQueueDbPath())) {
      return { status: 200, body: JSON.stringify({ summary: emptyPortfolioQueueSummary() }) };
    }
    return { status: 200, body: JSON.stringify({ summary: summarizePortfolioQueueRows(queue.listQueue()) }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to read local portfolio queue";
    return { status: 500, body: JSON.stringify({ error: message }) };
  }
}

/** Vite dev/preview middleware serving the local read-only portfolio-queue endpoint. */
export function portfolioQueueApiPlugin(deps: PortfolioQueueApiDeps = defaultDeps): Plugin {
  const attach = (middlewares: {
    use: (
      fn: (
        req: { method?: string; url?: string },
        res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void },
        next: () => void,
      ) => void,
    ) => void;
  }) => {
    middlewares.use((req, res, next) => {
      void handlePortfolioQueueRequest(req.method, req.url, deps).then((handled) => {
        if (!handled) return next();
        res.statusCode = handled.status;
        res.setHeader("Content-Type", "application/json");
        res.end(handled.body);
      });
    });
  };
  return {
    name: "gittensory-miner-ui:portfolio-queue-api",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
