export type RankedCandidateInput = {
    repoFullName: string;
    issueNumber: number;
    title?: string;
    htmlUrl?: string | null;
    rankScore: number;
    laneFit?: number;
    freshness?: number;
    potential?: number;
    feasibility?: number;
    dupRisk?: number;
};
export type RankedCandidateRow = {
    repoFullName: string;
    issueNumber: number;
    title: string;
    htmlUrl: string | null;
    rankScore: number;
    laneFit: number;
    freshness: number;
    potential: number;
    feasibility: number;
    dupRisk: number;
    rankedAt: string;
};
export type RankedCandidatesSaveResult = {
    count: number;
    rankedAt: string;
};
export type RankedCandidatesStore = {
    dbPath: string;
    saveRankedCandidates(candidates: RankedCandidateInput[], nowMs?: number): RankedCandidatesSaveResult;
    listRankedCandidates(): RankedCandidateRow[];
    close(): void;
};
export declare function resolveRankedCandidatesDbPath(env?: Record<string, string | undefined>): string;
/**
 * Opens the 100% local/client-side ranked-candidates snapshot store. The database only lives on this machine;
 * this module never uploads, syncs, or phones home with its contents.
 */
export declare function initRankedCandidatesStore(dbPath?: string): RankedCandidatesStore;
export declare function saveRankedCandidates(candidates: RankedCandidateInput[], nowMs?: number): RankedCandidatesSaveResult;
export declare function listRankedCandidates(): RankedCandidateRow[];
export declare function closeDefaultRankedCandidatesStore(): void;
