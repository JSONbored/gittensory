import type { GovernorPauseCliOptions } from "./governor-pause-cli.js";
import type { GovernorLedger, GovernorLedgerEntry } from "./governor-ledger.js";
export type GovernorLedgerEventType = "allowed" | "denied" | "throttled" | "kill_switch";
export type ParsedGovernorListArgs = {
    json: boolean;
    repoFullName: string | null;
    type: GovernorLedgerEventType | null;
} | {
    error: string;
};
export type GovernorCliOptions = {
    initGovernorLedger?: () => GovernorLedger;
    nowMs?: number;
} & GovernorPauseCliOptions;
export declare function parseGovernorListArgs(args: string[]): ParsedGovernorListArgs;
export declare function filterGovernorEvents(events: GovernorLedgerEntry[], options?: {
    type?: string | null;
}): GovernorLedgerEntry[];
export declare function renderGovernorTable(events: GovernorLedgerEntry[]): string;
export declare function runGovernorList(args: string[], options?: GovernorCliOptions): Promise<number>;
export declare function runGovernorCli(subcommand: string | undefined, args: string[], options?: GovernorCliOptions): Promise<number>;
