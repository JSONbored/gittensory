// Miner-ui wire for discover/attempt chat actions (#7076).
//
// Binds the shared registry registrations (packages/loopover-miner/lib/chat-discover-attempt-actions.js) to the
// existing `requestDiscover` / `requestAttempt` clients — the same POST /api/discover and POST /api/attempt path
// the miner-ui already uses. Also owns the pending-aware dispatch helper and result unwrap for the chat surface.
// Wiring ChatConversation to actually invoke these from a resolved chat message is a deliberate follow-up.

import {
  CHAT_ACTION_DISPATCH_ENABLE_VALUE,
  CHAT_ACTION_DISPATCH_FLAG,
  dispatchChatAction,
  type ChatActionDispatchResult,
} from "../../../../packages/loopover-miner/lib/chat-action-dispatch.js";
import { type ChatActionRegistry } from "../../../../packages/loopover-miner/lib/chat-action-registry.js";
import {
  ATTEMPT_CHAT_ACTION,
  DISCOVER_CHAT_ACTION,
  registerDiscoverAttemptChatActions as registerDiscoverAttemptChatActionsCore,
} from "../../../../packages/loopover-miner/lib/chat-discover-attempt-actions.js";
import { requestAttempt, type AttemptActionResult } from "./attempt";
import { requestDiscover, type DiscoverActionResult } from "./discover";

export {
  ATTEMPT_CHAT_ACTION,
  DISCOVER_CHAT_ACTION,
  isAttemptChatParams,
  isDiscoverChatParams,
} from "../../../../packages/loopover-miner/lib/chat-discover-attempt-actions.js";

export type DiscoverAttemptChatActionName = typeof DISCOVER_CHAT_ACTION | typeof ATTEMPT_CHAT_ACTION;

export type RegisterDiscoverAttemptChatActionsOptions = {
  registry?: ChatActionRegistry;
  requestDiscoverFn?: typeof requestDiscover;
  requestAttemptFn?: typeof requestAttempt;
  evaluateGate?: () => { decision: { stage: string } };
};

/** Idempotently register both actions, defaulting to the real `./discover` / `./attempt` clients. */
export function registerDiscoverAttemptChatActions(options: RegisterDiscoverAttemptChatActionsOptions = {}): void {
  registerDiscoverAttemptChatActionsCore({
    requestDiscover: options.requestDiscoverFn ?? requestDiscover,
    requestAttempt: options.requestAttemptFn ?? requestAttempt,
    registry: options.registry,
    evaluateGate: options.evaluateGate,
  });
}

export type RunDiscoverAttemptChatActionOptions = {
  env?: Record<string, string | undefined>;
  registry?: ChatActionRegistry;
  /** Flipped true for the duration of the dispatch (mirrors the Ledgers pending pattern). */
  onPending?: (pending: boolean) => void;
};

/**
 * Dispatch a discover/attempt chat action through the shared flag-gated entry point. Always goes through
 * `dispatchChatAction` — never calls the registered handler directly.
 */
export async function runDiscoverAttemptChatAction(
  request: { action: DiscoverAttemptChatActionName; params?: unknown },
  options: RunDiscoverAttemptChatActionOptions = {},
): Promise<ChatActionDispatchResult> {
  options.onPending?.(true);
  try {
    return await dispatchChatAction(request, { env: options.env, registry: options.registry });
  } finally {
    options.onPending?.(false);
  }
}

/** Env map that enables chat-action dispatch (the only truthy value the shared flag accepts). */
export function enabledChatActionsEnv(): Record<string, string> {
  return { [CHAT_ACTION_DISPATCH_FLAG]: CHAT_ACTION_DISPATCH_ENABLE_VALUE };
}

/**
 * Unwrap a successful dispatch envelope to the inner `requestDiscover` / `requestAttempt` result. Returns null
 * when dispatch did not execute (disabled / unknown / invalid / gated).
 */
export function unwrapDiscoverAttemptChatResult(
  dispatchResult: ChatActionDispatchResult,
): DiscoverActionResult | AttemptActionResult | null {
  if (dispatchResult.status !== "dispatched") return null;
  const gated = dispatchResult.result as
    { status?: string; result?: DiscoverActionResult | AttemptActionResult } | undefined;
  if (gated?.status !== "executed") return null;
  const inner = gated.result;
  if (inner == null || typeof inner !== "object" || !("ok" in inner)) return null;
  return inner;
}

export { CHAT_ACTION_DISPATCH_FLAG, CHAT_ACTION_DISPATCH_ENABLE_VALUE };
