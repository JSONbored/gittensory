import type { ChatActionRegistry } from "./chat-action-registry.js";

export const DISCOVER_CHAT_ACTION: "discover";
export const ATTEMPT_CHAT_ACTION: "attempt";

export type DiscoverChatActionInput = {
  targets?: string[];
  search?: string;
  dryRun?: boolean;
  json?: boolean;
  apiBaseUrl?: string;
  tokenEnv?: string;
};

export type AttemptChatActionInput = {
  repoFullName: string;
  issueNumber: number;
  minerLogin: string;
  base?: string;
  live?: boolean;
  dryRun?: boolean;
  json?: boolean;
};

export function isDiscoverChatParams(params: unknown): boolean;
export function isAttemptChatParams(params: unknown): boolean;

export function registerDiscoverAttemptChatActions(options: {
  requestDiscover: (input: DiscoverChatActionInput) => Promise<unknown>;
  requestAttempt: (input: AttemptChatActionInput) => Promise<unknown>;
  registry?: ChatActionRegistry;
  evaluateGate?: () => { decision: { stage: string } };
}): void;
