import type { CodingAgentDriver, CodingAgentDriverResult, CodingAgentDriverTask } from "../src/miner/coding-agent-driver.js";

export type LoadTestOptions = {
  levels?: number[];
  attemptCount?: number;
  latencyMs?: number;
};

export type LoadTestLevelResult = {
  concurrency: number;
  attemptCount: number;
  latencyMs: number;
  wallMs: number;
  handoffCount: number;
  attemptsPerSecond: number;
};

export declare const DEFAULT_CONCURRENCY_LEVELS: number[];
export declare const DEFAULT_ATTEMPTS_PER_LEVEL: number;
export declare const DEFAULT_SIMULATED_DRIVER_LATENCY_MS: number;

export declare function buildFakeLoadTestDriver(latencyMs: number): CodingAgentDriver & {
  run(task: CodingAgentDriverTask): Promise<CodingAgentDriverResult>;
};

export declare function runConcurrencyLevel(
  concurrency: number,
  options?: LoadTestOptions,
): Promise<LoadTestLevelResult>;

export declare function runLoadTest(options?: LoadTestOptions): Promise<LoadTestLevelResult[]>;

export declare function formatLoadTestReport(results: readonly LoadTestLevelResult[]): string;
