// Chat action-dispatch allowlist registry (#6519). The shared scaffolding the three chat action-family child
// issues (discover/attempt, portfolio release/requeue, governor pause/resume) register their handlers into.
//
// SAFETY CONTRACT — this registry makes it structurally impossible to register a write that bypasses the
// Governor chokepoint. A handler is accepted ONLY if it was produced by `createChokepointRoutedHandler`, which
// routes the effect through `packages/loopover-miner/lib/governor-chokepoint.js`'s `evaluateGovernorChokepointGate`
// (the stateful wrapper around `packages/loopover-engine/src/governor/chokepoint.ts`'s fail-closed precedence
// ladder). A raw, unwrapped function is rejected at REGISTRATION time — not caught later by review discipline.
//
// This module ships with ZERO actions registered; the child issues add them.

import { evaluateGovernorChokepointGate } from "./governor-chokepoint.js";

// Non-enumerable brand marking a handler as chokepoint-routed. Only createChokepointRoutedHandler sets it, so a
// plain function can never satisfy the registration contract.
const CHOKEPOINT_ROUTED = Symbol("loopover.chatAction.chokepointRouted");

/**
 * Wrap a chat action's effect so it is evaluated through the Governor chokepoint gate before it runs, and brand
 * the result so `registerChatAction` will accept it. `build(request)` returns `{ chokepointInput, perform }`:
 * `chokepointInput` is fed to the gate, and `perform` (the actual local write) runs ONLY on a final `"allow"`
 * verdict. Any non-allow stage denies without performing. The gate is injectable for tests; it defaults to the
 * real `evaluateGovernorChokepointGate` so production always routes through it.
 */
export function createChokepointRoutedHandler(build, options = {}) {
  if (typeof build !== "function") {
    throw new Error(
      "createChokepointRoutedHandler requires a build(request) => { chokepointInput, perform } function",
    );
  }
  /* v8 ignore next -- default routes through the real governor-chokepoint wrapper; every test injects a fake evaluateGate to avoid constructing a full GovernorChokepointInput (that wiring is covered by governor-chokepoint's own tests). */
  const evaluateGate = options.evaluateGate ?? evaluateGovernorChokepointGate;
  const handler = async (request) => {
    const { chokepointInput, perform } = build(request);
    const gate = evaluateGate(chokepointInput);
    if (gate.decision.stage !== "allow") {
      return {
        ok: false,
        denied: true,
        stage: gate.decision.stage,
        decision: gate.decision,
      };
    }
    const result = await perform();
    return {
      ok: true,
      stage: gate.decision.stage,
      decision: gate.decision,
      result,
    };
  };
  Object.defineProperty(handler, CHOKEPOINT_ROUTED, {
    value: true,
    enumerable: false,
  });
  return handler;
}

/** True only for a handler produced by `createChokepointRoutedHandler`. */
export function isChokepointRoutedHandler(handler) {
  return typeof handler === "function" && handler[CHOKEPOINT_ROUTED] === true;
}

const registry = new Map();

/**
 * Register a chat action. Rejects (throws) — never silently succeeds — when the name is empty, the
 * paramsValidator is missing, the handler was not produced by `createChokepointRoutedHandler`, or the name is
 * already registered.
 */
export function registerChatAction(name, definition = {}) {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("registerChatAction requires a non-empty action name");
  }
  const { paramsValidator, handler } = definition;
  if (typeof paramsValidator !== "function") {
    throw new Error(
      `chat action "${name}" must supply a paramsValidator function`,
    );
  }
  if (!isChokepointRoutedHandler(handler)) {
    throw new Error(
      `chat action "${name}" handler must be produced by createChokepointRoutedHandler so every write routes through the Governor chokepoint`,
    );
  }
  if (registry.has(name)) {
    throw new Error(`chat action "${name}" is already registered`);
  }
  const entry = Object.freeze({ paramsValidator, handler });
  registry.set(name, entry);
  return entry;
}

/** The registered action entry, or null when the name is not registered. */
export function getChatAction(name) {
  return registry.get(name) ?? null;
}

/** Registered action names, sorted, for a stable allowlist view. */
export function listChatActionNames() {
  return [...registry.keys()].sort();
}

/* v8 ignore next 3 -- test support: reset the module-level registry between tests so state never leaks. */
export function clearChatActionRegistry() {
  registry.clear();
}
