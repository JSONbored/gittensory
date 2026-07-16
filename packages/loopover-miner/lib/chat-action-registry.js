// Allowlist registry + governor-gated handler contract for chat-issued miner actions (#6519).
//
// Shared scaffolding ONLY: this module ships with ZERO registered actions. The three action-family child
// issues (portfolio release/requeue, governor pause/resume, discover/attempt) register their handlers into
// this registry -- none are added here, and the default `chatActionRegistry` instance starts empty.
//
// The registration contract is the safety boundary. `register` refuses any handler that was not produced by
// `governorGatedHandler()`, and `governorGatedHandler()` routes every invocation through
// `evaluateGovernorChokepointGate` (packages/loopover-miner/lib/governor-chokepoint.js) and, through it, the
// fail-closed precedence ladder in packages/loopover-engine/src/governor/chokepoint.ts. Because a raw
// function can never be registered, a chat action can never perform a write on a path that bypasses the
// Governor chokepoint -- the contract enforces it structurally, not by review discipline. This module adds
// no second, competing safety check; it only forces every registered handler onto the existing one.

import { evaluateGovernorChokepointGate } from "./governor-chokepoint.js";

// Private brand. Not exported, so external code cannot forge a "gated" marker onto a raw function: the only
// way to obtain a handler that passes `isGovernorGatedHandler` is to build it through `governorGatedHandler`.
const GOVERNOR_GATED = Symbol("loopover.chat-action.governor-gated");

/**
 * Wrap a local-write `run` function into a Governor-gated chat-action handler. The returned handler
 * evaluates the write against the full precedence ladder (via `evaluateGovernorChokepointGate`) BEFORE
 * running `run`, and only invokes `run` on a final `"allow"` verdict -- any other stage returns a gated
 * result and `run` never executes. This is the ONLY factory that produces a handler `register` accepts.
 *
 * @param {(request: unknown, gate: object) => unknown} run the local write to perform once the gate allows
 * @param {{ evaluateGate?: typeof evaluateGovernorChokepointGate, gateOptions?: object }} [options]
 * @returns {((request: { governorInput?: unknown }) => Promise<object>)}
 */
export function governorGatedHandler(run, options = {}) {
  if (typeof run !== "function") {
    throw new TypeError("governorGatedHandler(run): run must be a function");
  }
  const evaluateGate = options.evaluateGate ?? evaluateGovernorChokepointGate;
  if (typeof evaluateGate !== "function") {
    throw new TypeError("governorGatedHandler: options.evaluateGate must be a function when supplied");
  }

  const handler = async (request) => {
    const gate = evaluateGate(request?.governorInput, options.gateOptions);
    if (gate?.decision?.stage !== "allow") {
      return { ok: false, status: "gated", decision: gate?.decision ?? null };
    }
    const result = await run(request, gate);
    return { ok: true, status: "executed", decision: gate.decision, result };
  };
  Object.defineProperty(handler, GOVERNOR_GATED, { value: true });
  return handler;
}

/** True only for a handler produced by {@link governorGatedHandler}. */
export function isGovernorGatedHandler(handler) {
  return typeof handler === "function" && handler[GOVERNOR_GATED] === true;
}

/**
 * Build an isolated chat-action registry. Child issues register into the shared {@link chatActionRegistry};
 * this factory exists so tests (and any future multi-registry consumer) can register without polluting it.
 */
export function createChatActionRegistry() {
  const actions = new Map();

  function register(name, definition = {}) {
    if (typeof name !== "string" || name.trim() === "") {
      throw new TypeError("registerChatAction(name): name must be a non-empty string");
    }
    if (actions.has(name)) {
      throw new Error(`registerChatAction: action "${name}" is already registered`);
    }
    const { paramsValidator, handler } = definition;
    if (typeof paramsValidator !== "function") {
      throw new TypeError(`registerChatAction("${name}"): paramsValidator must be a function`);
    }
    if (!isGovernorGatedHandler(handler)) {
      throw new Error(
        `registerChatAction("${name}"): handler must be produced by governorGatedHandler() so every ` +
          "chat-triggered write routes through governor-chokepoint.js -- a raw handler is rejected.",
      );
    }
    const entry = { paramsValidator, handler };
    actions.set(name, entry);
    return entry;
  }

  return {
    register,
    get: (name) => actions.get(name),
    has: (name) => actions.has(name),
    names: () => [...actions.keys()],
    get size() {
      return actions.size;
    },
  };
}

/** The single shared registry the dispatch layer reads. Ships EMPTY (#6519); child issues register into it. */
export const chatActionRegistry = createChatActionRegistry();

/** Register a chat action on the shared {@link chatActionRegistry}. */
export function registerChatAction(name, definition) {
  return chatActionRegistry.register(name, definition);
}
