import { existsSync } from "node:fs";
import type { Plugin } from "vite";

// Portfolio-queue release/requeue action surface for the miner-ui (#4857, the queue half): the governor half
// (vite-governor-api.ts) already established that /api/* write endpoints are safe once vite-auth.ts (#4858)
// authenticates every request. This file is the deliberately-deferred "follow-up" that governor-api.ts's own
// header comment calls out: acting on a specific queue item needs its `repoFullName`/`identifier`, which the
// read-only portfolio-queue API (vite-portfolio-queue-api.ts) intentionally never republishes -- it only ever
// serves aggregated status counts, by design, to avoid leaking the queue's rank-derived `priority` ordering.
//
// The resolution here is a NARROW, purpose-built read route (`/api/queue/actionable`) that exposes ONLY the two
// slices an operator actually needs to act on -- in-flight items (releasable) and completed items (requeueable)
// -- and only the fields needed to identify + act on them (apiBaseUrl/repoFullName/identifier, plus a
// leasedAt/enqueuedAt timestamp for context). `priority` is stripped from every response on this route, same as
// the read-only sibling's own rule.
//
// Bridges directly to `packages/gittensory-miner/lib/portfolio-queue.js`'s EXISTING store methods
// (`listInProgress`/`listQueue`/`reclaimStuckItem`/`requeueItem`) -- the SAME functions
// `gittensory-miner queue release`/`queue requeue` already use (portfolio-queue-cli.js) -- no new queue
// semantics are invented here.

type QueueEntry = {
  apiBaseUrl: string;
  repoFullName: string;
  identifier: string;
  status: string;
  enqueuedAt: string;
};

type QueueLeaseEntry = {
  apiBaseUrl: string;
  repoFullName: string;
  identifier: string;
  status: string;
  leasedAt: string | null;
};

type PortfolioQueueStore = {
  listInProgress: () => QueueLeaseEntry[];
  listQueue: (repoFullName?: string | null) => QueueEntry[];
  reclaimStuckItem: (repoFullName: string, identifier: string, apiBaseUrl?: string) => QueueEntry | null;
  requeueItem: (repoFullName: string, identifier: string, apiBaseUrl?: string) => QueueEntry | null;
  close: () => void;
};

type PortfolioQueueModule = {
  resolvePortfolioQueueDbPath: () => string;
  initPortfolioQueueStore: () => PortfolioQueueStore;
};

export type QueueActionsApiDeps = {
  /** Import of `packages/gittensory-miner/lib/portfolio-queue.js` — injectable so tests never touch a real store. */
  loadPortfolioQueueModule: () => Promise<PortfolioQueueModule>;
  /** File-existence probe for the fresh-install fast path on both the GET route and the two POST routes: acting
   *  on an item in a store that does not exist yet can never succeed, so this avoids creating the file as a
   *  side effect of a doomed-to-fail action (unlike governor pause/resume, which legitimately DOES create the
   *  store on a fresh install — pausing is a valid first write, but releasing/requeuing a specific item that by
   *  definition cannot exist yet is not). */
  fileExists: (path: string) => boolean;
};

const defaultDeps: QueueActionsApiDeps = {
  loadPortfolioQueueModule: () =>
    import("../../packages/gittensory-miner/lib/portfolio-queue.js") as Promise<PortfolioQueueModule>,
  fileExists: existsSync,
};

type ReleasableItem = { apiBaseUrl: string; repoFullName: string; identifier: string; leasedAt: string | null };
type RequeueableItem = { apiBaseUrl: string; repoFullName: string; identifier: string; enqueuedAt: string };

type ActionOutcome =
  { ok: true; entry: Omit<QueueEntry, "status"> & { status: string } } | { ok: false; error: string };

type QueueActionsRoute = "actionable-get" | "release-post" | "requeue-post";

/** Pure route matcher, no I/O — mirrors matchGovernorRoute's shape/contract exactly. */
export function matchQueueActionsRoute(method: string | undefined, url: string | undefined): QueueActionsRoute | null {
  if (url === "/api/queue/actionable" && (method === undefined || method === "GET")) return "actionable-get";
  if (url === "/api/queue/release" && method === "POST") return "release-post";
  if (url === "/api/queue/requeue" && method === "POST") return "requeue-post";
  return null;
}

/** Collects a request body into a string — identical shape to vite-governor-api.ts's own helper. */
function readRequestBody(req: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

type ActionTarget = { repoFullName: string; identifier: string; apiBaseUrl: string | undefined };

/** Parses the required `{ repoFullName, identifier, apiBaseUrl? }` POST body. Returns null for an empty/invalid
 *  body or missing required fields — unlike the governor pause route's optional reason, a release/requeue
 *  action is meaningless without knowing WHICH item to act on, so a malformed body here is a real 400, not a
 *  silently-tolerated default. */
function parseActionTarget(rawBody: string): ActionTarget | null {
  if (!rawBody.trim()) return null;
  try {
    const parsed = JSON.parse(rawBody) as { repoFullName?: unknown; identifier?: unknown; apiBaseUrl?: unknown };
    if (typeof parsed.repoFullName !== "string" || !parsed.repoFullName.trim()) return null;
    if (typeof parsed.identifier !== "string" || !parsed.identifier.trim()) return null;
    const apiBaseUrl =
      typeof parsed.apiBaseUrl === "string" && parsed.apiBaseUrl.trim() ? parsed.apiBaseUrl : undefined;
    return { repoFullName: parsed.repoFullName, identifier: parsed.identifier, apiBaseUrl };
  } catch {
    return null;
  }
}

function stripPriority(entry: QueueEntry): Omit<QueueEntry, never> {
  const { apiBaseUrl, repoFullName, identifier, status, enqueuedAt } = entry;
  return { apiBaseUrl, repoFullName, identifier, status, enqueuedAt };
}

/** Executes an ALREADY-MATCHED queue-actions route. Never returns null, mirroring respondToGovernorRoute. */
async function respondToQueueActionsRoute(
  route: QueueActionsRoute,
  rawBody: string,
  deps: QueueActionsApiDeps,
): Promise<{ status: number; body: string }> {
  try {
    const portfolioQueue = await deps.loadPortfolioQueueModule();

    if (route === "actionable-get") {
      if (!deps.fileExists(portfolioQueue.resolvePortfolioQueueDbPath())) {
        return { status: 200, body: JSON.stringify({ releasable: [], requeueable: [] }) };
      }
      const store = portfolioQueue.initPortfolioQueueStore();
      try {
        const releasable: ReleasableItem[] = store
          .listInProgress()
          .map(({ apiBaseUrl, repoFullName, identifier, leasedAt }) => ({
            apiBaseUrl,
            repoFullName,
            identifier,
            leasedAt,
          }));
        const requeueable: RequeueableItem[] = store
          .listQueue()
          .filter((entry) => entry.status === "done")
          .map(({ apiBaseUrl, repoFullName, identifier, enqueuedAt }) => ({
            apiBaseUrl,
            repoFullName,
            identifier,
            enqueuedAt,
          }));
        return { status: 200, body: JSON.stringify({ releasable, requeueable }) };
      } finally {
        store.close();
      }
    }

    // route is "release-post" or "requeue-post" from here.
    const target = parseActionTarget(rawBody);
    if (!target) return { status: 400, body: JSON.stringify({ error: "invalid_request_body" }) };

    if (!deps.fileExists(portfolioQueue.resolvePortfolioQueueDbPath())) {
      const outcome: ActionOutcome = {
        ok: false,
        error: route === "release-post" ? "queue_entry_not_in_progress" : "queue_entry_not_requeuable",
      };
      return { status: 200, body: JSON.stringify(outcome) };
    }

    const store = portfolioQueue.initPortfolioQueueStore();
    try {
      const entry =
        route === "release-post"
          ? store.reclaimStuckItem(target.repoFullName, target.identifier, target.apiBaseUrl)
          : store.requeueItem(target.repoFullName, target.identifier, target.apiBaseUrl);
      const outcome: ActionOutcome = entry
        ? { ok: true, entry: stripPriority(entry) }
        : { ok: false, error: route === "release-post" ? "queue_entry_not_in_progress" : "queue_entry_not_requeuable" };
      return { status: 200, body: JSON.stringify(outcome) };
    } finally {
      store.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to update the local portfolio queue";
    return { status: 500, body: JSON.stringify({ error: message }) };
  }
}

/** The request handler, factored out of the Vite plugin shape so tests drive it directly. Returns null when the
 *  request is for none of the three queue-actions routes. */
export async function handleQueueActionsRequest(
  method: string | undefined,
  url: string | undefined,
  rawBody: string,
  deps: QueueActionsApiDeps = defaultDeps,
): Promise<{ status: number; body: string } | null> {
  const route = matchQueueActionsRoute(method, url);
  if (!route) return null;
  return respondToQueueActionsRoute(route, rawBody, deps);
}

/** Vite dev/preview middleware serving the queue actionable-items read + release/requeue write endpoints. */
export function queueActionsApiPlugin(deps: QueueActionsApiDeps = defaultDeps): Plugin {
  const attach = (middlewares: {
    use: (
      fn: (
        req: { method?: string; url?: string } & NodeJS.ReadableStream,
        res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void },
        next: () => void,
      ) => void,
    ) => void;
  }) => {
    middlewares.use((req, res, next) => {
      const route = matchQueueActionsRoute(req.method, req.url);
      if (!route) return next();
      void readRequestBody(req)
        .then((rawBody) => respondToQueueActionsRoute(route, rawBody, deps))
        .then((handled) => {
          res.statusCode = handled.status;
          res.setHeader("Content-Type", "application/json");
          res.end(handled.body);
        });
    });
  };
  return {
    name: "gittensory-miner-ui:queue-actions-api",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
