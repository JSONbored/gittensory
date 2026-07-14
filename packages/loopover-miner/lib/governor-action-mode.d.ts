import type { MinerActionMode, MinerKillSwitchScope } from "@loopover/engine";
import type { AppendGovernorEventInput, GovernorLedgerEntry } from "./governor-ledger.js";

export type ResolveMinerActionModeGateInput = {
  killSwitchScope: MinerKillSwitchScope;
  repoLiveModeOptIn?: unknown;
  env?: Record<string, string | undefined>;
};

export type ResolveMinerActionModeGateResult = {
  mode: MinerActionMode;
  executes: boolean;
};

export function resolveMinerActionModeGate(input: ResolveMinerActionModeGateInput): ResolveMinerActionModeGateResult;

export type RecordMinerDryRunShadowInput = {
  repoFullName?: string;
  actionClass: string;
  wouldBeAction: Record<string, unknown>;
};

export function recordMinerDryRunShadow(
  input: RecordMinerDryRunShadowInput,
  options?: { append?: (event: AppendGovernorEventInput) => GovernorLedgerEntry },
): GovernorLedgerEntry;
