import type { GovernorChokepointInput, GovernorDecision, WriteRateLimitBackoffStore, WriteRateLimitBucketStore } from "@loopover/engine";
import type { AppendGovernorEventInput, GovernorLedgerEntry } from "./governor-ledger.js";

export type EvaluateGovernorChokepointGateResult = {
  decision: GovernorDecision;
  recorded: GovernorLedgerEntry;
  rateLimitBuckets: WriteRateLimitBucketStore;
  rateLimitBackoffAttempts: WriteRateLimitBackoffStore;
};

export function evaluateGovernorChokepointGate(
  input: GovernorChokepointInput,
  options?: { append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry },
): EvaluateGovernorChokepointGateResult;
