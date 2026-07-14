import type { MinerActionMode, MinerKillSwitchScope } from "@loopover/engine";
import type { CodingAgentExecutionMode } from "@loopover/engine";
import type { ForgeConfig } from "./forge-config.js";

export function resolveDocumentedKillSwitchScope(
  env: Record<string, string | undefined>,
  repoPaused: boolean,
): MinerKillSwitchScope;

export function resolveDocumentedGovernorActionMode(input: {
  killSwitchScope: MinerKillSwitchScope;
  repoLiveModeOptIn?: unknown;
  globalLiveModeOptIn: boolean;
}): MinerActionMode;

export function resolveDocumentedCodingAgentMode(
  env: Record<string, string | undefined>,
  cliLiveFlag: boolean,
): CodingAgentExecutionMode;

export function resolveDocumentedDiscoverTokenEnvVar(input?: {
  cliTokenEnv?: string | null;
  optionsTokenEnv?: string | null;
  forge?: Partial<ForgeConfig>;
}): string;
