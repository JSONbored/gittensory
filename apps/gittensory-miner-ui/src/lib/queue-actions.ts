// Client for the local queue-actions read + release/requeue write API (#4857, the queue half of "Add real
// actions to the miner-ui"). Mirrors governor.ts's shape (typed result unions, no throw on a bad response, a
// guard narrowing the parsed JSON payload) — the miner-ui's second write surface, safe for the same reason
// governor.ts's actions are: vite-auth.ts (#4858) authenticates every /api/* request, including these.

export const QUEUE_ACTIONABLE_API_PATH = "/api/queue/actionable";
export const QUEUE_RELEASE_API_PATH = "/api/queue/release";
export const QUEUE_REQUEUE_API_PATH = "/api/queue/requeue";

export type ReleasableItem = { apiBaseUrl: string; repoFullName: string; identifier: string; leasedAt: string | null };
export type RequeueableItem = { apiBaseUrl: string; repoFullName: string; identifier: string; enqueuedAt: string };

export type QueueActionableResult =
  { ok: true; releasable: ReleasableItem[]; requeueable: RequeueableItem[] } | { ok: false; error: string };

export type QueueActionEntry = {
  apiBaseUrl: string;
  repoFullName: string;
  identifier: string;
  status: string;
  enqueuedAt: string;
};

export type QueueActionResult = { ok: true; entry: QueueActionEntry } | { ok: false; error: string };

function isReleasableItem(value: unknown): value is ReleasableItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.apiBaseUrl === "string" &&
    typeof item.repoFullName === "string" &&
    typeof item.identifier === "string" &&
    (item.leasedAt === null || typeof item.leasedAt === "string")
  );
}

function isRequeueableItem(value: unknown): value is RequeueableItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.apiBaseUrl === "string" &&
    typeof item.repoFullName === "string" &&
    typeof item.identifier === "string" &&
    typeof item.enqueuedAt === "string"
  );
}

/** Fetch the actionable-items snapshot (in-flight items releasable, completed items requeueable); failures
 *  surface as a typed error result the view renders, never a crash. */
export async function fetchQueueActionable(fetchImpl: typeof fetch = fetch): Promise<QueueActionableResult> {
  try {
    const response = await fetchImpl(QUEUE_ACTIONABLE_API_PATH);
    if (!response.ok) return { ok: false, error: `local queue-actionable API responded ${response.status}` };
    const payload = (await response.json()) as { releasable?: unknown; requeueable?: unknown };
    if (
      !Array.isArray(payload.releasable) ||
      !payload.releasable.every(isReleasableItem) ||
      !Array.isArray(payload.requeueable) ||
      !payload.requeueable.every(isRequeueableItem)
    ) {
      return { ok: false, error: "local queue-actionable API returned an unexpected payload shape" };
    }
    return { ok: true, releasable: payload.releasable, requeueable: payload.requeueable };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "failed to reach the local queue-actionable API",
    };
  }
}

async function postQueueAction(
  path: string,
  target: { repoFullName: string; identifier: string; apiBaseUrl: string },
  fetchImpl: typeof fetch,
): Promise<QueueActionResult> {
  try {
    // Only the three fields the API reads, never the whole (possibly wider) item object a caller passed in --
    // ReleasableItem/RequeueableItem carry an extra leasedAt/enqueuedAt field the server has no use for.
    const { repoFullName, identifier, apiBaseUrl } = target;
    const response = await fetchImpl(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoFullName, identifier, apiBaseUrl }),
    });
    const payload = (await response.json()) as { ok?: unknown; entry?: unknown; error?: unknown };
    if (payload.ok === true && typeof payload.entry === "object" && payload.entry !== null) {
      return { ok: true, entry: payload.entry as QueueActionEntry };
    }
    const error =
      typeof payload.error === "string" ? payload.error : `local queue action API responded ${response.status}`;
    return { ok: false, error };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "failed to reach the local queue action API" };
  }
}

/** Release an in-flight item back to the queue (mirrors `gittensory-miner queue release <owner/repo> <identifier>`). */
export function releaseQueueItem(
  target: { repoFullName: string; identifier: string; apiBaseUrl: string },
  fetchImpl: typeof fetch = fetch,
): Promise<QueueActionResult> {
  return postQueueAction(QUEUE_RELEASE_API_PATH, target, fetchImpl);
}

/** Requeue a completed item so it is picked up again (mirrors `gittensory-miner queue requeue <owner/repo> <identifier>`). */
export function requeueQueueItem(
  target: { repoFullName: string; identifier: string; apiBaseUrl: string },
  fetchImpl: typeof fetch = fetch,
): Promise<QueueActionResult> {
  return postQueueAction(QUEUE_REQUEUE_API_PATH, target, fetchImpl);
}
