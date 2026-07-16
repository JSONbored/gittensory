import type { ChatActionRegistry } from "./chat-action-registry.js";

export const GOVERNOR_PAUSE_CHAT_ACTION: "governor_pause";
export const GOVERNOR_RESUME_CHAT_ACTION: "governor_resume";

export function isGovernorPauseChatParams(params: unknown): boolean;
export function isGovernorResumeChatParams(params: unknown): boolean;

export function registerGovernorChatActions(options: {
  pauseGovernor: (reason?: string) => Promise<unknown>;
  resumeGovernor: () => Promise<unknown>;
  registry?: ChatActionRegistry;
  evaluateGate?: () => { decision: { stage: string } };
}): void;
