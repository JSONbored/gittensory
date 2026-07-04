import type { RejectionReason } from "./rejection-templates.js";

export type ParsedRejectionListArgs =
  | {
      json: boolean;
    }
  | { error: string };

export type ParsedRejectionRenderArgs =
  | {
      reason: RejectionReason;
      repoFullName: string;
      prNumber: number;
      json: boolean;
    }
  | { error: string };

export function parseRejectionListArgs(args: string[]): ParsedRejectionListArgs;

export function parseRejectionRenderArgs(args: string[]): ParsedRejectionRenderArgs;

export function renderRejectionReasonTable(reasons: readonly string[]): string;

export function runRejectionList(args: string[]): number;

export function runRejectionRender(args: string[]): number;

export function runRejectionCli(subcommand: string | undefined, args: string[]): number;
