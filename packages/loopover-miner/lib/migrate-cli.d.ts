export type MigrateStatus = "skipped" | "up-to-date" | "migrated" | "failed";
export type MigrateResult = {
    name: string;
    dbPath: string;
    ok: boolean;
    status: MigrateStatus;
    detail: string;
    versionBefore: number | null;
    versionAfter: number | null;
};
export type MigrateStoreDescriptor = {
    name: string;
    resolveDbPath: (env?: Record<string, string | undefined>) => string;
    open: (dbPath: string) => {
        close: () => void;
    };
};
/** `stores` is injectable so tests can exercise a store descriptor's failure paths (e.g. a non-Error throw)
 *  without depending on real node:sqlite error shapes; defaults to the real seven-store list. */
export declare function runMigrateChecks(env?: Record<string, string | undefined>, stores?: MigrateStoreDescriptor[]): MigrateResult[];
export declare function runMigrate(args?: string[], env?: Record<string, string | undefined>): number;
