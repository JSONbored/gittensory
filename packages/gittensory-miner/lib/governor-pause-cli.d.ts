import type { GovernorState } from "./governor-state.js";

export type ParsedGovernorPauseArgs = { json: boolean; reason: string | null } | { error: string };

export type ParsedGovernorNoArgsSubcommand = { json: boolean } | { error: string };

export type GovernorPauseCliOptions = {
  openGovernorState?: () => GovernorState;
};

export function parseGovernorPauseArgs(args: string[]): ParsedGovernorPauseArgs;

export function runGovernorPause(args: string[], options?: GovernorPauseCliOptions): Promise<number>;

export function runGovernorResume(args: string[], options?: GovernorPauseCliOptions): Promise<number>;

export function runGovernorStatus(args: string[], options?: GovernorPauseCliOptions): Promise<number>;
