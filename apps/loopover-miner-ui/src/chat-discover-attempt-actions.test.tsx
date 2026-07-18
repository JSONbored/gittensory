import { describe, expect, it, vi } from "vitest";

// chat-action-registry → governor-chokepoint → governor-ledger → node:sqlite, which jsdom/Vite cannot bundle
// (#6521); keep a client-safe registry twin so the real dispatch + registration modules load. Mirrors the twin
// in chat-governor-actions.test.tsx.
vi.mock("../../../packages/loopover-miner/lib/chat-action-registry.js", () => {
  const GOVERNOR_GATED = Symbol("loopover.chat-action.governor-gated");

  function isGovernorGatedHandler(handler: unknown): boolean {
    return typeof handler === "function" && (handler as unknown as { [k: symbol]: unknown })[GOVERNOR_GATED] === true;
  }

  function governorGatedHandler(
    run: (request: unknown, gate: unknown) => unknown,
    options: { evaluateGate?: (input?: unknown) => { decision: { stage: string } } } = {},
  ) {
    const evaluateGate = options.evaluateGate ?? (() => ({ decision: { stage: "allow" } }));
    const handler = async (request: { governorInput?: unknown }) => {
      const gate = evaluateGate(request?.governorInput);
      if (gate?.decision?.stage !== "allow") {
        return { ok: false, status: "gated", decision: gate?.decision ?? null };
      }
      const result = await run(request, gate);
      return { ok: true, status: "executed", decision: gate.decision, result };
    };
    Object.defineProperty(handler, GOVERNOR_GATED, { value: true });
    return handler;
  }

  function createChatActionRegistry() {
    const actions = new Map<
      string,
      { paramsValidator: (params: unknown) => boolean; handler: (request: unknown) => Promise<unknown> }
    >();
    return {
      register(
        name: string,
        definition: {
          paramsValidator: (params: unknown) => boolean;
          handler: (request: unknown) => Promise<unknown>;
        },
      ) {
        if (!isGovernorGatedHandler(definition.handler)) {
          throw new Error(`registerChatAction("${name}"): handler must be produced by governorGatedHandler()`);
        }
        actions.set(name, definition);
        return definition;
      },
      get: (name: string) => actions.get(name),
      has: (name: string) => actions.has(name),
      names: () => [...actions.keys()],
      get size() {
        return actions.size;
      },
    };
  }

  return {
    createChatActionRegistry,
    governorGatedHandler,
    isGovernorGatedHandler,
    chatActionRegistry: createChatActionRegistry(),
    registerChatAction: () => {
      throw new Error("tests use an injected isolated registry");
    },
  };
});

import { createChatActionRegistry } from "../../../packages/loopover-miner/lib/chat-action-registry.js";
import { requestAttempt, type AttemptActionResult } from "./lib/attempt";
import {
  ATTEMPT_CHAT_ACTION,
  DISCOVER_CHAT_ACTION,
  enabledChatActionsEnv,
  registerDiscoverAttemptChatActions,
  runDiscoverAttemptChatAction,
  unwrapDiscoverAttemptChatResult,
} from "./lib/chat-discover-attempt-actions";
import { requestDiscover, type DiscoverActionResult } from "./lib/discover";

const discoverOk: DiscoverActionResult = { ok: true, result: { opportunities: [] }, exitCode: 0 };
const attemptOk: AttemptActionResult = { ok: true, result: { pullNumber: 123 }, exitCode: 0 };
const attemptParams = { repoFullName: "acme/widgets", issueNumber: 42, minerLogin: "miner1" };

describe("chat-discover-attempt-actions wire (#7076)", () => {
  it("registers both discover and attempt into the shared registry", () => {
    const registry = createChatActionRegistry();
    registerDiscoverAttemptChatActions({ registry });
    expect(registry.has(DISCOVER_CHAT_ACTION)).toBe(true);
    expect(registry.has(ATTEMPT_CHAT_ACTION)).toBe(true);
  });

  it("dispatches discover through the injected requestDiscover client with the forwarded params", async () => {
    const registry = createChatActionRegistry();
    const requestDiscoverFn = vi.fn(async () => discoverOk);
    registerDiscoverAttemptChatActions({ registry, requestDiscoverFn, requestAttemptFn: vi.fn(async () => attemptOk) });

    const dispatched = await runDiscoverAttemptChatAction(
      { action: DISCOVER_CHAT_ACTION, params: { search: "flaky", dryRun: true } },
      { env: enabledChatActionsEnv(), registry },
    );
    expect(requestDiscoverFn).toHaveBeenCalledWith({ search: "flaky", dryRun: true });
    expect(unwrapDiscoverAttemptChatResult(dispatched)).toEqual(discoverOk);
  });

  it("forwards {} to requestDiscover when the params are nullish (discover with defaults)", async () => {
    const registry = createChatActionRegistry();
    const requestDiscoverFn = vi.fn(async () => discoverOk);
    registerDiscoverAttemptChatActions({ registry, requestDiscoverFn, requestAttemptFn: vi.fn(async () => attemptOk) });
    await runDiscoverAttemptChatAction({ action: DISCOVER_CHAT_ACTION }, { env: enabledChatActionsEnv(), registry });
    expect(requestDiscoverFn).toHaveBeenCalledWith({});
  });

  it("dispatches attempt through the injected requestAttempt client with the validated params", async () => {
    const registry = createChatActionRegistry();
    const requestAttemptFn = vi.fn(async () => attemptOk);
    registerDiscoverAttemptChatActions({
      registry,
      requestDiscoverFn: vi.fn(async () => discoverOk),
      requestAttemptFn,
    });

    const dispatched = await runDiscoverAttemptChatAction(
      { action: ATTEMPT_CHAT_ACTION, params: attemptParams },
      { env: enabledChatActionsEnv(), registry },
    );
    expect(requestAttemptFn).toHaveBeenCalledWith(attemptParams);
    expect(unwrapDiscoverAttemptChatResult(dispatched)).toEqual(attemptOk);
  });

  it("regression: default wiring binds the real ./discover and ./attempt clients", async () => {
    const discoverSpy = vi.spyOn(await import("./lib/discover"), "requestDiscover").mockResolvedValue(discoverOk);
    const attemptSpy = vi.spyOn(await import("./lib/attempt"), "requestAttempt").mockResolvedValue(attemptOk);

    const registry = createChatActionRegistry();
    registerDiscoverAttemptChatActions({ registry });

    await runDiscoverAttemptChatAction(
      { action: DISCOVER_CHAT_ACTION, params: { search: "x" } },
      { env: enabledChatActionsEnv(), registry },
    );
    expect(discoverSpy).toHaveBeenCalledWith({ search: "x" });

    await runDiscoverAttemptChatAction(
      { action: ATTEMPT_CHAT_ACTION, params: attemptParams },
      { env: enabledChatActionsEnv(), registry },
    );
    expect(attemptSpy).toHaveBeenCalledWith(attemptParams);

    discoverSpy.mockRestore();
    attemptSpy.mockRestore();
  });

  it("is idempotent: a second registration keeps the first handlers (registry.has guard)", () => {
    const registry = createChatActionRegistry();
    registerDiscoverAttemptChatActions({
      registry,
      requestDiscoverFn: vi.fn(async () => discoverOk),
      requestAttemptFn: vi.fn(async () => attemptOk),
    });
    const firstEntry = registry.get(DISCOVER_CHAT_ACTION);
    registerDiscoverAttemptChatActions({
      registry,
      requestDiscoverFn: vi.fn(async () => discoverOk),
      requestAttemptFn: vi.fn(async () => attemptOk),
    });
    expect(registry.get(DISCOVER_CHAT_ACTION)).toBe(firstEntry); // second register is a no-op
  });

  it("unwrapDiscoverAttemptChatResult returns null for non-executed dispatch envelopes", () => {
    expect(unwrapDiscoverAttemptChatResult({ ok: false, status: "disabled", action: DISCOVER_CHAT_ACTION })).toBeNull();
    expect(
      unwrapDiscoverAttemptChatResult({
        ok: true,
        status: "dispatched",
        action: DISCOVER_CHAT_ACTION,
        result: { status: "gated", decision: null },
      }),
    ).toBeNull();
  });

  it("defaults to the real discover/attempt module exports", () => {
    expect(typeof requestDiscover).toBe("function");
    expect(typeof requestAttempt).toBe("function");
  });
});
