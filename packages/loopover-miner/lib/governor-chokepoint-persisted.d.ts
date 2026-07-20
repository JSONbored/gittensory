import type { GovernorChokepointInput } from "@loopover/engine";
import type { EvaluateGovernorChokepointGateResult } from "./governor-chokepoint.js";
import type { GovernorState } from "./governor-state.js";
import type { AppendGovernorEventInput, GovernorLedgerEntry } from "./governor-ledger.js";
export type GovernorChokepointInputPersisted = Omit<GovernorChokepointInput, "rateLimitBuckets" | "rateLimitBackoffAttempts" | "capUsage"> & Partial<Pick<GovernorChokepointInput, "rateLimitBuckets" | "rateLimitBackoffAttempts" | "capUsage">>;
export declare function evaluateGovernorChokepointGatePersisted(input: GovernorChokepointInputPersisted, options?: {
    governorState?: GovernorState;
    append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry;
}): EvaluateGovernorChokepointGateResult;
