import type {
  CrossRepoEvaluationResult,
  CrossRepoEvaluationSummary,
  ParsedCrossRepoEvaluationManifest,
} from "../lib/cross-repo-evaluation.js";

export type CrossRepoEvaluationCliArgs =
  | { manifestPath: string; json: boolean; repoFilter: string | null; requireMajority: boolean }
  | { error: string }
  | { help: true };

export type CrossRepoEvaluationCliOptions = {
  parsed?: ParsedCrossRepoEvaluationManifest;
  manifestPath?: string;
  repoFilter?: string | null;
};

export declare function resolveDefaultManifestPath(): string;

export declare function parseCrossRepoEvaluationArgs(argv?: readonly string[]): CrossRepoEvaluationCliArgs;

export declare function loadCrossRepoEvaluationManifest(manifestPath: string): ParsedCrossRepoEvaluationManifest;

export declare function runCrossRepoEvaluationCli(options?: CrossRepoEvaluationCliOptions): {
  parsed: ParsedCrossRepoEvaluationManifest;
  results: CrossRepoEvaluationResult[];
  summary: CrossRepoEvaluationSummary;
};
