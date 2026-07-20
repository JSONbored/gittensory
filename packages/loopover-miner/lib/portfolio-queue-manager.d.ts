import type { PortfolioCaps } from "@loopover/engine";
import type { EnqueueItem, PortfolioQueueStore, QueueEntry } from "./portfolio-queue.js";
export type PortfolioQueueClaimTarget = {
    apiBaseUrl: string;
    repoFullName: string;
    identifier: string;
};
/**
 * Stable composite id for projecting SQLite rows into the engine's PortfolioQueueItem shape. Encodes apiBaseUrl
 * too (#5563) — the engine's own selection logic has no forge dimension, but two hosts can now enqueue an item
 * under the same repoFullName+identifier (post-#5563 scoping), and the id is the ONLY thing selectEligibleBatch's
 * output threads back to batchClaim; without the host baked in here, a selected item's host would be lost and
 * batchClaim would default to github.com, potentially claiming a DIFFERENT row than the one the engine selected.
 */
export declare function queueItemId(apiBaseUrl: string, repoFullName: string, identifier: string): string;
/** Reverse {@link queueItemId} after engine selection so claims can target SQLite primary keys. */
export declare function parseQueueItemId(id: unknown): PortfolioQueueClaimTarget;
/** Coerce caps to finite non-negative integers (mirrors the engine's normalizeCaps posture). */
export declare function normalizePortfolioCaps(caps?: Partial<PortfolioCaps>): PortfolioCaps;
/** Project persisted queue rows into the engine's in-memory PortfolioQueue (done rows omitted). Pure. */
export declare function entriesToPortfolioQueue(entries: QueueEntry[]): {
    buckets: Array<{
        repoFullName: string;
        items: Array<{
            id: string;
            repoFullName: string;
            state: "queued" | "in_progress";
        }>;
    }>;
};
/** Select the next eligible batch from active rows using the engine primitive. Pure. */
export declare function selectEligibleBatch(entries: QueueEntry[], caps: PortfolioCaps): PortfolioQueueClaimTarget[];
export type PortfolioQueueManager = {
    caps: PortfolioCaps;
    store: PortfolioQueueStore;
    dbPath: string;
    enqueue(item: EnqueueItem): QueueEntry;
    listQueue(repoFullName?: string | null): QueueEntry[];
    markDone(repoFullName: string, identifier: string, apiBaseUrl?: string): QueueEntry | null;
    markFailed(repoFullName: string, identifier: string, apiBaseUrl?: string): QueueEntry | null;
    reclaimStuckItems(maxLeaseMs?: number): QueueEntry[];
    claimNextBatch(): QueueEntry[];
    close(): void;
};
export type InitPortfolioQueueManagerOptions = {
    caps?: Partial<PortfolioCaps>;
    store?: PortfolioQueueStore;
    dbPath?: string;
    staleLeaseMs?: number;
};
/**
 * Open a caps-aware portfolio queue manager backed by the local SQLite store. The existing single-row
 * `dequeueNext()` CLI surface is untouched — this adds `claimNextBatch()` for fleet-style batch claiming.
 */
export declare function initPortfolioQueueManager(options?: InitPortfolioQueueManagerOptions): PortfolioQueueManager;
export declare function closeDefaultPortfolioQueueManager(): void;
