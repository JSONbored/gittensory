export declare const ATTEMPT_LOG_NOT_PURGEABLE_NOTE = "attempt-log has no repoFullName column and cannot be purged by repo (#5564); its rows are unaffected";
export type ParsedPurgeArgs = {
    json: boolean;
    dryRun: boolean;
    repoFullName: string;
} | {
    error: string;
};
export declare function parsePurgeArgs(args: string[]): ParsedPurgeArgs;
export type PurgeStoreResult = {
    store: string;
    purged: number | null;
    error?: string;
    note?: string;
};
export type PurgeDryRunStoreResult = {
    store: string;
    wouldPurge: number | null;
    error?: string;
};
export type PurgeDryRunResult = {
    outcome: "dry_run";
    repoFullName: string;
    stores: PurgeDryRunStoreResult[];
    attemptLogNote: string;
    attemptLogTotalRows: number;
};
export type PurgeSummary = {
    outcome: "purged" | "partial";
    repoFullName: string;
    totalPurged: number;
    stores: PurgeStoreResult[];
    purgedAt: string;
};
export type PurgeCliOptions = {
    resolveDbPaths?: Record<string, () => string>;
} & Record<string, unknown>;
export declare function runPurgeDryRun(parsed: {
    repoFullName: string;
    json: boolean;
}, options?: PurgeCliOptions): number;
export declare function runPurge(args: string[], options?: PurgeCliOptions): number;
