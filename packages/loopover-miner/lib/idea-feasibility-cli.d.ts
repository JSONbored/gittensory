import type { AssessIdeaFeasibilityOptions } from "./idea-feasibility.js";
import type { FeasibilityClaimStatus, FeasibilityDuplicateClusterRisk } from "@loopover/engine";
export type ParsedIdeaFeasibilityArgs = {
    claimStatus: FeasibilityClaimStatus;
    duplicateClusterRisk: FeasibilityDuplicateClusterRisk;
    targetResolvable: boolean;
    acceptanceHints: string[];
    json: boolean;
} | {
    error: string;
};
export declare function parseIdeaFeasibilityArgs(args: string[]): ParsedIdeaFeasibilityArgs;
export type RunIdeaFeasibilityCliOptions = AssessIdeaFeasibilityOptions;
export declare function runIdeaFeasibilityCli(args: string[], options?: RunIdeaFeasibilityCliOptions): number;
