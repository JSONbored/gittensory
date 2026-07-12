import type { GovernorDecisionEntry, GovernorLedger, GovernorLedgerEntry } from "./governor-ledger.js";

export type GovernorLedgerEventType = "allowed" | "denied" | "throttled" | "kill_switch";

export type ParsedGovernorListArgs =
  | {
      json: boolean;
      repoFullName: string | null;
      type: GovernorLedgerEventType | null;
    }
  | { error: string };

export function parseGovernorListArgs(args: string[]): ParsedGovernorListArgs;

export function filterGovernorEvents(
  events: GovernorLedgerEntry[],
  options?: { type?: string | null },
): GovernorLedgerEntry[];

export const GOVERNOR_DECISION_ENTRY_FIELDS: readonly [
  "ts",
  "eventType",
  "repoFullName",
  "actionClass",
  "decision",
  "reason",
];

export type GovernorDecisionMcpFilterInput = {
  repoFullName?: string | null;
  type?: string | null;
};

export function normalizeGovernorDecisionMcpFilter(input?: GovernorDecisionMcpFilterInput): {
  repoFullName: string | null;
  type: GovernorLedgerEventType | null;
};

export function collectGovernorLedgerDecisions(
  governorLedger: Pick<GovernorLedger, "readGovernorDecisions">,
  filter?: { repoFullName?: string | null; type?: string | null },
): {
  repoFullName?: string;
  decisions: GovernorDecisionEntry[];
};

export function renderGovernorTable(events: GovernorLedgerEntry[]): string;

export function runGovernorList(
  args: string[],
  options?: { initGovernorLedger?: () => GovernorLedger },
): Promise<number>;

export function runGovernorCli(
  subcommand: string | undefined,
  args: string[],
  options?: { initGovernorLedger?: () => GovernorLedger },
): Promise<number>;
