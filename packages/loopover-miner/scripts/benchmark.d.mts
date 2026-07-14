export type BenchmarkCandidate = {
  repoFullName: string;
  issueNumber: number;
  title: string;
  labels: string[];
  commentsCount: number;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  aiPolicyAllowed: boolean;
  aiPolicySource: "AI-USAGE.md" | "none";
};

export type BenchmarkOptions = {
  candidateCount?: number;
  operationCount?: number;
  iterations?: number;
};

export type BenchmarkResult = {
  name: string;
  unitCount: number;
  iterations: number;
  medianMs: number;
  opsPerSecond: number;
};

export declare const DEFAULT_CANDIDATE_COUNT: number;
export declare const DEFAULT_QUEUE_OPERATION_COUNT: number;
export declare const DEFAULT_ITERATIONS: number;

export declare function buildSyntheticCandidates(count: number): BenchmarkCandidate[];

export declare function runRankingBenchmark(options?: BenchmarkOptions): BenchmarkResult;

export declare function runLocalStoreBenchmark(options?: BenchmarkOptions): BenchmarkResult;

export declare function formatBenchmarkReport(results: readonly BenchmarkResult[]): string;
