import type { AgentSdkHooks, AgentSdkQueryFn, CliSubprocessSpawnFn, CodingAgentDriver } from "@loopover/engine";

export function createRealCliSubprocessSpawn(): CliSubprocessSpawnFn;

export type ConstructProductionCodingAgentDriverOptions = {
  spawn?: CliSubprocessSpawnFn;
  query?: AgentSdkQueryFn;
  hooks?: AgentSdkHooks;
  listChangedFiles?: (cwd: string) => Promise<string[]>;
  houseRulesConfig?: unknown;
  houseRulesOptions?: unknown;
};

export function constructProductionCodingAgentDriver(
  env: Record<string, string | undefined>,
  options?: ConstructProductionCodingAgentDriverOptions,
): CodingAgentDriver;
