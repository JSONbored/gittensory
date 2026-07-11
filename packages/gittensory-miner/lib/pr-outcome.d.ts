import type { AppendEventInput, LedgerEntry } from "./event-ledger.js";

export const MINER_PR_OUTCOME_EVENT: "pr_outcome";
export const MINER_PR_OUTCOME_DECISIONS: readonly ["merged", "closed"];

export type MinerPrOutcomeDecision = "merged" | "closed";

export interface NormalizedPrOutcomePayload {
  prNumber: number;
  decision: MinerPrOutcomeDecision;
  closedAt: string | null;
  reason: string | null;
}

export interface PrOutcomeInput {
  repoFullName?: unknown;
  prNumber?: unknown;
  decision?: unknown;
  closedAt?: unknown;
  reason?: unknown;
}

export interface RecordPrOutcomeOptions {
  /** Optional at the type level so a caller can pass an unusable ledger to exercise the fail-closed guard; the
   *  writer throws `invalid_event_ledger` at runtime when this is absent or lacks `appendEvent`. Reuses the
   *  real EventLedger#appendEvent signature so a genuine EventLedger (not just a same-shaped stub) type-checks. */
  eventLedger?: { appendEvent(event: AppendEventInput): LedgerEntry };
}

export interface PrOutcomeLedgerReader {
  readEvents(filter?: { since?: number; repoFullName?: string }): unknown[];
}

export function normalizePrOutcomePayload(payload: unknown): NormalizedPrOutcomePayload | null;

export function recordPrOutcomeSnapshot(input: PrOutcomeInput, options?: RecordPrOutcomeOptions): unknown;

export function readPrOutcomes(
  eventLedger: PrOutcomeLedgerReader,
  filter?: { since?: number; repoFullName?: string },
): Map<string, NormalizedPrOutcomePayload & { repoFullName: string }>;
