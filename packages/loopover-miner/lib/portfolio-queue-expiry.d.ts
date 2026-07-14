import type { QueueEntry, QueueLeaseEntry } from "./portfolio-queue.js";

export declare const DEFAULT_MAX_LEASE_MS: number;

export type PortfolioQueueExpiryStore = {
  listInProgress(): QueueLeaseEntry[];
  reclaimStuckItem(repoFullName: string, identifier: string): QueueEntry | null;
};

export function findStuckItems(
  items: QueueLeaseEntry[],
  nowMs: number,
  maxLeaseMs: number,
): QueueLeaseEntry[];

export function sweepStuckItems(
  store: PortfolioQueueExpiryStore,
  nowMs: number,
  maxLeaseMs?: number,
): QueueEntry[];
