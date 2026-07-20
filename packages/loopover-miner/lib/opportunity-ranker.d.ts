import type { MinerGoalSpec } from "@loopover/engine";
import type { RawCandidateIssue } from "./opportunity-fanout.js";
export type RankedCandidateIssue = RawCandidateIssue & {
    potential: number;
    feasibility: number;
    laneFit: number;
    freshness: number;
    dupRisk: number;
    rankScore: number;
};
export type RankCandidateIssuesOptions = {
    nowMs?: number;
    highRiskDuplicateClusters?: number;
    openPullRequests?: number;
    goalSpecsByRepo?: Record<string, MinerGoalSpec>;
    goalSpecContentByRepo?: Record<string, string>;
};
export type RankedCandidateSummary = {
    issues: RankedCandidateIssue[];
    skippedInvalid: number;
    usedDefaultGoalSpec: boolean;
    defaultGoalSpec: MinerGoalSpec;
};
/**
 * Rank metadata-only fan-out candidates locally. Never clones source, never uploads metadata, and never writes to
 * GitHub — it only composes deterministic engine signals and returns the sorted list.
 */
export declare function rankCandidateIssues(candidates: RawCandidateIssue[], options?: RankCandidateIssuesOptions): RankedCandidateIssue[];
export declare function rankCandidateIssuesWithSummary(candidates: RawCandidateIssue[], options?: RankCandidateIssuesOptions): RankedCandidateSummary;
