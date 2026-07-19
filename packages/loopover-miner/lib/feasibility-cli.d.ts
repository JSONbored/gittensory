import type { FeasibilityClaimStatus, FeasibilityDuplicateClusterRisk, FeasibilityGateInput, FeasibilityGateResult, FeasibilityIssueStatus } from "@loopover/engine";
export type ParsedFeasibilityArgs = {
    claimStatus: FeasibilityClaimStatus;
    duplicateClusterRisk: FeasibilityDuplicateClusterRisk;
    issueStatus: FeasibilityIssueStatus;
    found: boolean;
    json: boolean;
} | {
    error: string;
};
export declare function parseFeasibilityArgs(args: string[]): ParsedFeasibilityArgs;
export type RunFeasibilityCliOptions = {
    buildFeasibilityVerdict?: (input: FeasibilityGateInput) => FeasibilityGateResult;
};
export declare function runFeasibilityCli(args: string[], options?: RunFeasibilityCliOptions): number;
