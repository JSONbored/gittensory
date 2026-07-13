import type { CodingAgentDriverName } from "@loopover/engine";

export const WIZARD_ENV_FILENAME: string;
export const DEFAULT_TIMEOUT_MS: number;
export const MASKED_SECRET: string;

export type WizardIo = {
  print(line: string): void;
  prompt(question: string): Promise<string>;
  /** Reads an answer WITHOUT echoing it — used for the GitHub token. */
  promptMasked(question: string): Promise<string>;
  close?(): void;
};

export type CompanionPrompt = {
  envKey: string;
  label: string;
  defaultValue: string;
};

export type CollectedEnv = Record<string, string>;

export type InitWizardResult =
  | { cancelled: true; reason: "declined_overwrite" | "missing_token" | "invalid_provider"; envPath: string }
  | { cancelled: false; envPath: string; values: CollectedEnv; env: Record<string, string | undefined> };

export function buildProviderMenu(): string[];
export function parseProviderChoice(raw: unknown): CodingAgentDriverName | null;
export function companionPromptsFor(provider: CodingAgentDriverName): CompanionPrompt[];
export function normalizeTimeoutMs(raw: unknown, defaultValue?: number): number | null;
export function formatEnvValue(value: unknown): string;
export function renderEnvFile(values: CollectedEnv, now?: string): string;
export function summarizeCollectedEnv(values: CollectedEnv, secretKeys?: string[]): string[];
export function writeEnvFile(envPath: string, contents: string): string;

export function runInitWizard(options: {
  stateDir: string;
  io: WizardIo;
  env?: Record<string, string | undefined>;
  now?: string;
}): Promise<InitWizardResult>;

export function createStdioWizardIo(input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream): WizardIo;
