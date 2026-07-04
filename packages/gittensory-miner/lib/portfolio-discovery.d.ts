import type { EventLedger } from "./event-ledger.js";
import type { PortfolioQueueStore } from "./portfolio-queue.js";
import type { RankedCandidateIssue } from "./opportunity-ranker.js";

export type EnqueueRankedDiscoveryOptions = {
  queueStore: PortfolioQueueStore;
  eventLedger?: EventLedger;
  minRankScore?: number | null;
};

export type EnqueueRankedDiscoverySummary = {
  enqueued: number;
  skippedBelowMinRank: number;
  skippedInvalid: number;
  eventsAppended: number;
};

export function enqueueRankedDiscovery(
  rankedIssues: RankedCandidateIssue[],
  options: EnqueueRankedDiscoveryOptions,
): EnqueueRankedDiscoverySummary;
