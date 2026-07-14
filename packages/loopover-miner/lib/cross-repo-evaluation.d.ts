import type { RepoStackResult } from "./stack-detection.js";

export const CROSS_REPO_FAILURE_CATEGORY: Readonly<{
  STACK_DETECTION: "stack_detection_gap";
  EXECUTION: "execution_gap";
  GITTENSOR_ASSUMPTION: "loopover_assumption";
  CLONE_SETUP: "clone_setup";
  OTHER: "other";
}>;

export const GITTENSOR_POSITIVE_ASSUMPTION_CHECKS: ReadonlyArray<{
  id: string;
  pattern: RegExp;
}>;

export const DEFAULT_CROSS_REPO_MANIFEST_RELATIVE_PATH: string;
export const MAX_CROSS_REPO_MANIFEST_BYTES: number;
export const MAX_CROSS_REPO_MANIFEST_REPOS: number;

export type CrossRepoEvaluationManifestRepo = {
  repoFullName: string;
  stackHint?: string;
  requireTestCommand?: boolean;
  fixturePath?: string;
};

export type ParsedCrossRepoEvaluationManifest = {
  present: boolean;
  manifest: { repos: CrossRepoEvaluationManifestRepo[] };
  warnings: string[];
};

export type CrossRepoEvaluationResult = {
  repoFullName: string;
  passed: boolean;
  failureCategory: string | null;
  reason: string | null;
  stackDetected: boolean;
  usedDefaultGoalSpec: boolean | null;
  assumptionFindings: Array<{ id: string; line: string }>;
  stack?: RepoStackResult;
};

export type CrossRepoEvaluationSummary = {
  total: number;
  passed: number;
  failed: number;
  majorityPassed: boolean;
  withoutLoopoverConfig: number;
  failuresByCategory: Record<string, number>;
};

export function normalizeCrossRepoFullName(value: unknown): string | null;

export function parseCrossRepoEvaluationManifest(
  content: string | null | undefined,
): ParsedCrossRepoEvaluationManifest;

export function scanPositiveLoopoverAssumptions(text: string): Array<{ id: string; line: string }>;

export function evaluateRepoReadiness(
  entry: CrossRepoEvaluationManifestRepo,
  options?: {
    repoPath?: string;
    resolveRepoPath?: (entry: { repoFullName: string }) => string;
    env?: NodeJS.ProcessEnv;
    existsSync?: (path: string) => boolean;
    detectRepoStack?: (repoPath: string) => RepoStackResult;
    resolveMinerGoalSpec?: (repoPath: string) => { present: boolean };
    buildCodingTaskSpec?: (input: Record<string, unknown>) => {
      ready: boolean;
      verdict?: string;
      instructions?: string;
    };
  },
): CrossRepoEvaluationResult;

export function runCrossRepoEvaluation(
  parsed: ParsedCrossRepoEvaluationManifest,
  options?: {
    repoFilter?: string;
  } & Parameters<typeof evaluateRepoReadiness>[1],
): CrossRepoEvaluationResult[];

export function summarizeCrossRepoEvaluation(results: CrossRepoEvaluationResult[]): CrossRepoEvaluationSummary;

export function formatCrossRepoEvaluationReport(
  results: CrossRepoEvaluationResult[],
  summary?: CrossRepoEvaluationSummary,
): string;
