// Chat action-dispatch single entry point (#6519). Every action a chat input issues MUST go through this
// function — it is never a parallel or bypass route around the miner's existing safety path. The actual write
// runs inside a handler that was registered via `chat-action-registry.js`'s `createChokepointRoutedHandler`,
// which routes through `packages/loopover-miner/lib/governor-chokepoint.js`'s `evaluateGovernorChokepointGate`
// (the stateful wrapper around `packages/loopover-engine/src/governor/chokepoint.ts`'s fail-closed precedence
// ladder). This module adds no second, competing safety check; it only gates, looks up, validates, and invokes.
//
// This issue ships the scaffolding only: the flag defaults OFF and the registry is empty, so no action can run
// yet. The discover/attempt, portfolio release/requeue, and governor pause/resume child issues register handlers.

import { getChatAction } from "./chat-action-registry.js";

// Explicit enable values only — anything else (unset, empty, "off", "0", a typo) is disabled. Fail closed.
const ENABLE_VALUE = /^(1|true|yes|on|enabled)$/i;

/** True only when the per-install flag is explicitly enabled; every other value (incl. unset/empty) is OFF. */
export function isChatActionDispatchEnabled(env = process.env) {
  return ENABLE_VALUE.test((env.MINER_CHAT_ACTIONS ?? "").trim());
}

export const CHAT_ACTION_DISPATCH_STATUS = Object.freeze({
  DISABLED: "chat_action_dispatch_disabled",
  UNKNOWN_ACTION: "chat_action_unknown",
  INVALID_PARAMS: "chat_action_invalid_params",
  DISPATCHED: "chat_action_dispatched",
});

/**
 * Dispatch a chat-issued action request `{ action, params }`. Fail-closed order: the flag is checked FIRST —
 * when disabled it short-circuits before the registry is touched or any params are validated. Otherwise it
 * rejects an unknown action, then runs the action's own params-validator (rejecting, never coercing, on
 * failure), and only then invokes the registered (chokepoint-routed) handler.
 */
export async function dispatchChatAction(request, options = {}) {
  const env = options.env ?? process.env;
  if (!isChatActionDispatchEnabled(env)) {
    return { ok: false, status: CHAT_ACTION_DISPATCH_STATUS.DISABLED };
  }
  const action = typeof request?.action === "string" ? request.action : "";
  const registered = getChatAction(action);
  if (!registered) {
    return {
      ok: false,
      status: CHAT_ACTION_DISPATCH_STATUS.UNKNOWN_ACTION,
      action,
    };
  }
  const validation = registered.paramsValidator(request?.params);
  if (!validation || validation.ok !== true) {
    return {
      ok: false,
      status: CHAT_ACTION_DISPATCH_STATUS.INVALID_PARAMS,
      action,
      errors: Array.isArray(validation?.errors) ? validation.errors : [],
    };
  }
  const result = await registered.handler({ action, params: request?.params });
  return {
    ok: true,
    status: CHAT_ACTION_DISPATCH_STATUS.DISPATCHED,
    action,
    result,
  };
}
