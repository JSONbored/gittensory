// Governor pause/resume chat-action registrations (#6521).
//
// Child issue of the chat action-dispatch scaffolding (#6519). Registers `governor_pause` /
// `governor_resume` into a chat-action registry. Handlers MUST be wired to the miner-ui clients
// `pauseGovernor` / `resumeGovernor` (apps/loopover-miner-ui/src/lib/governor.ts) — never to
// governor-state.js and never via a hand-rolled fetch. The miner-ui wire module passes those clients
// in; this module only owns the registration contract + params validators.
//
// Pause/resume is administrative control, not a chokepoint content-write. The registry still requires
// a `governorGatedHandler` brand, so we supply an allow-stage evaluateGate rather than routing through
// governor-chokepoint.js. Execution stays behind the shared LOOPOVER_MINER_CHAT_ACTIONS flag via
// `dispatchChatAction`.

import { governorGatedHandler, chatActionRegistry } from "./chat-action-registry.js";

export const GOVERNOR_PAUSE_CHAT_ACTION = "governor_pause";
export const GOVERNOR_RESUME_CHAT_ACTION = "governor_resume";

/** Administrative pause/resume is not a chokepoint content-write (#6521); satisfy the registry brand only. */
const allowAdministrativeGate = () => ({ decision: { stage: "allow" } });

/**
 * Optional `{ reason?: string }` — absent/empty params are valid; a non-string reason is rejected.
 * @param {unknown} params
 * @returns {boolean}
 */
export function isGovernorPauseChatParams(params) {
  if (params == null) return true;
  if (typeof params !== "object" || Array.isArray(params)) return false;
  const keys = Object.keys(/** @type {object} */ (params));
  if (keys.length === 0) return true;
  if (keys.length === 1 && keys[0] === "reason") {
    const reason = /** @type {{ reason?: unknown }} */ (params).reason;
    return reason === undefined || typeof reason === "string";
  }
  return false;
}

/**
 * Resume takes no arguments — only nullish or an empty object is valid.
 * @param {unknown} params
 * @returns {boolean}
 */
export function isGovernorResumeChatParams(params) {
  if (params == null) return true;
  if (typeof params !== "object" || Array.isArray(params)) return false;
  return Object.keys(/** @type {object} */ (params)).length === 0;
}

/**
 * @param {unknown} params
 * @returns {string | undefined}
 */
function readOptionalPauseReason(params) {
  if (params == null || typeof params !== "object" || Array.isArray(params)) return undefined;
  const reason = /** @type {{ reason?: unknown }} */ (params).reason;
  // Mirror LedgersPage: empty string → undefined so pauseGovernor omits the body field.
  return typeof reason === "string" && reason ? reason : undefined;
}

/**
 * Idempotently register `governor_pause` / `governor_resume`.
 *
 * @param {{
 *   pauseGovernor: (reason?: string) => Promise<unknown>,
 *   resumeGovernor: () => Promise<unknown>,
 *   registry?: import("./chat-action-registry.js").ChatActionRegistry,
 *   evaluateGate?: () => { decision: { stage: string } },
 * }} options
 */
export function registerGovernorChatActions(options) {
  const pauseGovernor = options?.pauseGovernor;
  const resumeGovernor = options?.resumeGovernor;
  if (typeof pauseGovernor !== "function") {
    throw new TypeError("registerGovernorChatActions: pauseGovernor must be a function");
  }
  if (typeof resumeGovernor !== "function") {
    throw new TypeError("registerGovernorChatActions: resumeGovernor must be a function");
  }

  const registry = options.registry ?? chatActionRegistry;
  const evaluateGate = options.evaluateGate ?? allowAdministrativeGate;

  if (!registry.has(GOVERNOR_PAUSE_CHAT_ACTION)) {
    registry.register(GOVERNOR_PAUSE_CHAT_ACTION, {
      paramsValidator: isGovernorPauseChatParams,
      handler: governorGatedHandler(async (request) => pauseGovernor(readOptionalPauseReason(request?.params)), {
        evaluateGate,
      }),
    });
  }

  if (!registry.has(GOVERNOR_RESUME_CHAT_ACTION)) {
    registry.register(GOVERNOR_RESUME_CHAT_ACTION, {
      paramsValidator: isGovernorResumeChatParams,
      handler: governorGatedHandler(async () => resumeGovernor(), { evaluateGate }),
    });
  }
}
