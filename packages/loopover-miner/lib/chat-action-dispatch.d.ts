import type { ChatActionHandlerResult } from "./chat-action-registry.js";

export function isChatActionDispatchEnabled(
  env?: Record<string, string | undefined>,
): boolean;

export const CHAT_ACTION_DISPATCH_STATUS: {
  readonly DISABLED: "chat_action_dispatch_disabled";
  readonly UNKNOWN_ACTION: "chat_action_unknown";
  readonly INVALID_PARAMS: "chat_action_invalid_params";
  readonly DISPATCHED: "chat_action_dispatched";
};

export type ChatActionRequest = { action?: unknown; params?: unknown };

export type ChatActionDispatchResult =
  | { ok: false; status: "chat_action_dispatch_disabled" }
  | { ok: false; status: "chat_action_unknown"; action: string }
  | {
      ok: false;
      status: "chat_action_invalid_params";
      action: string;
      errors: string[];
    }
  | {
      ok: true;
      status: "chat_action_dispatched";
      action: string;
      result: ChatActionHandlerResult;
    };

export function dispatchChatAction(
  request: ChatActionRequest,
  options?: { env?: Record<string, string | undefined> },
): Promise<ChatActionDispatchResult>;
