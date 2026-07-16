import type { ChatActionRegistry, ChatActionRequest } from "./chat-action-registry.js";

export const CHAT_ACTION_DISPATCH_FLAG: string;
export const CHAT_ACTION_DISPATCH_ENABLE_VALUE: string;

export function isChatActionDispatchEnabled(env?: Record<string, string | undefined>): boolean;

export type ChatActionDispatchResult = {
  ok: boolean;
  status: string;
  action: string | null;
  [key: string]: unknown;
};

export function dispatchChatAction(
  request: ChatActionRequest,
  options?: {
    env?: Record<string, string | undefined>;
    registry?: ChatActionRegistry;
  },
): Promise<ChatActionDispatchResult>;
