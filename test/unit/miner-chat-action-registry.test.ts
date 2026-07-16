import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import type { GovernorChokepointInput } from "@loopover/engine";

import {
  clearChatActionRegistry,
  createChokepointRoutedHandler,
  getChatAction,
  isChokepointRoutedHandler,
  listChatActionNames,
  registerChatAction,
} from "../../packages/loopover-miner/lib/chat-action-registry.js";

// The injected fake gate ignores the input, so a typed placeholder stands in for a real GovernorChokepointInput.
const NO_INPUT = {} as unknown as GovernorChokepointInput;
const allowGate = () => ({ decision: { stage: "allow" } });
const denyGate = () => ({ decision: { stage: "kill_switch" } });

function wrapped(perform: () => unknown = () => "performed", gate = allowGate) {
  return createChokepointRoutedHandler(
    () => ({ chokepointInput: NO_INPUT, perform }),
    { evaluateGate: gate },
  );
}
const validator = () => ({ ok: true });

describe("chat-action-registry (#6519)", () => {
  afterEach(() => clearChatActionRegistry());

  it("REGRESSION: ships with zero actions registered", () => {
    // Runs first (before any registration or reset) — proves the module itself pre-registers nothing.
    expect(listChatActionNames()).toEqual([]);
    expect(getChatAction("anything")).toBeNull();
  });

  it("createChokepointRoutedHandler routes through the gate: performs on allow, denies (without performing) otherwise", async () => {
    const okHandler = wrapped(() => "did-it", allowGate);
    expect(isChokepointRoutedHandler(okHandler)).toBe(true);
    await expect(okHandler({ action: "x", params: {} })).resolves.toEqual({
      ok: true,
      stage: "allow",
      decision: { stage: "allow" },
      result: "did-it",
    });

    let performed = false;
    const deniedHandler = createChokepointRoutedHandler(
      () => ({
        chokepointInput: NO_INPUT,
        perform: () => {
          performed = true;
        },
      }),
      { evaluateGate: denyGate },
    );
    await expect(
      deniedHandler({ action: "x", params: {} }),
    ).resolves.toMatchObject({ ok: false, denied: true, stage: "kill_switch" });
    expect(performed).toBe(false);
  });

  it("createChokepointRoutedHandler requires a build function", () => {
    expect(() => createChokepointRoutedHandler(undefined as never)).toThrow(
      /build/,
    );
  });

  it("isChokepointRoutedHandler is false for a plain function or a non-function", () => {
    expect(isChokepointRoutedHandler(() => {})).toBe(false);
    expect(isChokepointRoutedHandler("nope")).toBe(false);
  });

  it("registers a wrapped handler and looks it up", () => {
    const handler = wrapped();
    registerChatAction("demo.action", { paramsValidator: validator, handler });
    expect(listChatActionNames()).toEqual(["demo.action"]);
    expect(getChatAction("demo.action")).toMatchObject({
      paramsValidator: validator,
      handler,
    });
  });

  it("rejects a raw (unwrapped) handler at registration time, not silently", () => {
    expect(() =>
      registerChatAction("bad", {
        paramsValidator: validator,
        handler: (async () => ({})) as never,
      }),
    ).toThrow(/createChokepointRoutedHandler/);
    expect(listChatActionNames()).toEqual([]);
  });

  it("rejects an empty name, a missing paramsValidator, and a duplicate registration", () => {
    expect(() =>
      registerChatAction("", {
        paramsValidator: validator,
        handler: wrapped(),
      }),
    ).toThrow(/non-empty/);
    expect(() =>
      registerChatAction("x", { handler: wrapped() } as never),
    ).toThrow(/paramsValidator/);
    registerChatAction("dup", {
      paramsValidator: validator,
      handler: wrapped(),
    });
    expect(() =>
      registerChatAction("dup", {
        paramsValidator: validator,
        handler: wrapped(),
      }),
    ).toThrow(/already registered/);
  });

  it("listChatActionNames returns a sorted view", () => {
    registerChatAction("z.action", {
      paramsValidator: validator,
      handler: wrapped(),
    });
    registerChatAction("a.action", {
      paramsValidator: validator,
      handler: wrapped(),
    });
    expect(listChatActionNames()).toEqual(["a.action", "z.action"]);
  });
});
