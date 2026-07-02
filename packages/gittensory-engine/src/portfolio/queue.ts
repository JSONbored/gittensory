/**
 * Portfolio queue primitives (#2326). Pure bookkeeping for the miner's local cross-repo work queue:
 * bucket items by repo, respect global/per-repo WIP caps, and select the next eligible batch in a
 * deterministic diversified order. No IO, no Date, no randomness, and no enforcement/action logic.
 */

export type PortfolioQueueItemState = "queued" | "in_progress";

export type PortfolioQueueItem = {
  id: string;
  repoFullName: string;
  state: PortfolioQueueItemState;
};

export type PortfolioQueueBucket = {
  repoFullName: string;
  items: PortfolioQueueItem[];
};

export type PortfolioQueue = {
  buckets: PortfolioQueueBucket[];
};

export type PortfolioCaps = {
  globalWipCap: number;
  perRepoWipCap: number;
};

type QueueSelectionBucket = {
  repoFullName: string;
  activeCount: number;
  queuedItems: PortfolioQueueItem[];
  selectedCount: number;
};

const QUEUED_STATE: PortfolioQueueItemState = "queued";
const ACTIVE_STATE: PortfolioQueueItemState = "in_progress";

function cleanId(value: string): string {
  return value.trim();
}

function normalizeState(value: PortfolioQueueItemState): PortfolioQueueItemState {
  return value === ACTIVE_STATE ? ACTIVE_STATE : QUEUED_STATE;
}

function finiteNonNegativeInt(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizeCaps(caps: PortfolioCaps): { globalWipCap: number; perRepoWipCap: number } {
  return {
    globalWipCap: finiteNonNegativeInt(caps.globalWipCap),
    perRepoWipCap: finiteNonNegativeInt(caps.perRepoWipCap),
  };
}

function isActiveItem(item: PortfolioQueueItem): boolean {
  return item.state === ACTIVE_STATE;
}

function isQueuedItem(item: PortfolioQueueItem): boolean {
  return item.state === QUEUED_STATE;
}

function projectedLoad(bucket: QueueSelectionBucket): number {
  return bucket.activeCount + bucket.selectedCount;
}

function pickNextBucket(
  buckets: QueueSelectionBucket[],
  lastRepoFullName: string | null,
): QueueSelectionBucket | null {
  const eligible = buckets.filter((bucket) => bucket.selectedCount < bucket.queuedItems.length);
  if (eligible.length === 0) return null;
  const alternates =
    lastRepoFullName === null ? eligible : eligible.filter((bucket) => bucket.repoFullName !== lastRepoFullName);
  const candidates = alternates.length > 0 ? alternates : eligible;
  let winner = candidates[0]!;
  for (const candidate of candidates.slice(1)) {
    const winnerLoad = projectedLoad(winner);
    const candidateLoad = projectedLoad(candidate);
    if (candidateLoad < winnerLoad) {
      winner = candidate;
    }
  }
  return winner;
}

function queueHasItem(queue: PortfolioQueue, itemId: string): boolean {
  return queue.buckets.some((bucket) => bucket.items.some((item) => cleanId(item.id) === itemId));
}

/** Append one item to the queue, creating its repo bucket if needed. Duplicate/blank ids are ignored. Pure. */
export function enqueueItem(queue: PortfolioQueue, item: PortfolioQueueItem): PortfolioQueue {
  const id = cleanId(item.id);
  const repoFullName = cleanId(item.repoFullName);
  if (!id || !repoFullName || queueHasItem(queue, id)) return queue;
  const normalizedItem: PortfolioQueueItem = { id, repoFullName, state: normalizeState(item.state) };
  const bucketIndex = queue.buckets.findIndex((bucket) => bucket.repoFullName === repoFullName);
  if (bucketIndex === -1) {
    return { buckets: [...queue.buckets, { repoFullName, items: [normalizedItem] }] };
  }
  return {
    buckets: queue.buckets.map((bucket, index) =>
      index === bucketIndex ? { ...bucket, items: [...bucket.items, normalizedItem] } : bucket,
    ),
  };
}

/** Remove matching items by id; empty buckets disappear. Unknown/blank ids are a no-op. Pure. */
export function dequeueItem(queue: PortfolioQueue, itemId: string): PortfolioQueue {
  const targetId = cleanId(itemId);
  if (!targetId) return queue;
  let removed = false;
  const buckets = queue.buckets.flatMap((bucket) => {
    const items = bucket.items.filter((item) => {
      const keep = cleanId(item.id) !== targetId;
      if (!keep) removed = true;
      return keep;
    });
    return items.length > 0 ? [{ ...bucket, items }] : [];
  });
  return removed ? { buckets } : queue;
}

/** Select the next batch of queued items that fit within global/per-repo WIP caps. The batch always alternates
 *  repos when another repo still has an eligible item waiting; among those eligible repos, lower current load wins
 *  and ties keep stable bucket order. Pure. */
export function nextEligibleItems(queue: PortfolioQueue, caps: PortfolioCaps): PortfolioQueueItem[] {
  const normalizedCaps = normalizeCaps(caps);
  if (normalizedCaps.globalWipCap === 0 || normalizedCaps.perRepoWipCap === 0) return [];

  const totalActiveCount = queue.buckets.reduce(
    (sum, bucket) => sum + bucket.items.filter(isActiveItem).length,
    0,
  );
  const remainingGlobalSlots = normalizedCaps.globalWipCap - totalActiveCount;
  if (remainingGlobalSlots <= 0) return [];

  const selectionBuckets = queue.buckets.map((bucket) => {
    const activeCount = bucket.items.filter(isActiveItem).length;
    const queuedItems = bucket.items.filter(isQueuedItem);
    const remainingPerRepoCapacity = normalizedCaps.perRepoWipCap - activeCount;
    return {
      repoFullName: bucket.repoFullName,
      activeCount,
      queuedItems: remainingPerRepoCapacity > 0 ? queuedItems.slice(0, remainingPerRepoCapacity) : [],
      selectedCount: 0,
    };
  });

  const selected: PortfolioQueueItem[] = [];
  let lastRepoFullName: string | null = null;
  while (selected.length < remainingGlobalSlots) {
    const nextBucket = pickNextBucket(selectionBuckets, lastRepoFullName);
    if (nextBucket === null) break;
    const nextItem = nextBucket.queuedItems[nextBucket.selectedCount]!;
    selected.push(nextItem);
    nextBucket.selectedCount += 1;
    lastRepoFullName = nextBucket.repoFullName;
  }
  return selected;
}
