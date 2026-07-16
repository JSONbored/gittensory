import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  CHAT_ACTION_DISPATCH_STATUS,
  dispatchChatAction,
  isChatActionDispatchEnabled,
} from "../../packages/loopover-miner/lib/chat-action-dispatch.js";
import type { GovernorChokepointInput } from "@loopover/engine";

import {
  clearChatActionRegistry,
  createChokepointRoutedHandler,
  registerChatAction,
} from "../../packages/loopover-miner/lib/chat-action-registry.js";

const ON = { MINER_CHAT_ACTIONS: "true" };
// The injected fake gate ignores the input, so a typed placeholder stands in for a real GovernorChokepointInput.
const NO_INPUT = {} as unknown as GovernorChokepointInput;

function registerDemo(
  perform: () => unknown = () => "ran",
  paramsValidator: (params: unknown) => {
    ok: boolean;
    errors?: string[];
  } = () => ({ ok: true }),
) {
  const handler = createChokepointRoutedHandler(
    () => ({ chokepointInput: NO_INPUT, perform }),
    {
      evaluateGate: () => ({ decision: { stage: "allow" } }),
    },
  );
  registerChatAction("demo", { paramsValidator, handler });
}

describe("chat-action-dispatch (#6519)", () => {
  afterEach(() => clearChatActionRegistry());

  it("isChatActionDispatchEnabled: only explicit enable values are on, everything else (incl. unset) is off", () => {
    for (const value of ["1", "true", "YES", "on", "enabled"]) {
      expect(isChatActionDispatchEnabled({ MINER_CHAT_ACTIONS: value })).toBe(
        true,
      );
    }
    for (const value of [undefined, "", "0", "off", "nope"]) {
      expect(isChatActionDispatchEnabled({ MINER_CHAT_ACTIONS: value })).toBe(
        false,
      );
    }
  });

  it("fail-closed: when disabled it returns DISABLED for a known-shaped request", async () => {
    registerDemo();
    const res = await dispatchChatAction(
      { action: "demo", params: {} },
      { env: {} },
    );
    expect(res).toEqual({
      ok: false,
      status: CHAT_ACTION_DISPATCH_STATUS.DISABLED,
    });
  });

  it("defaults env to process.env (unset MINER_CHAT_ACTIONS in test env => disabled)", async () => {
    const res = await dispatchChatAction({ action: "demo", params: {} });
    expect(res).toEqual({
      ok: false,
      status: CHAT_ACTION_DISPATCH_STATUS.DISABLED,
    });
  });

  it("rejects an unknown action, and a non-string/absent action name, when enabled", async () => {
    expect(
      await dispatchChatAction({ action: "nope", params: {} }, { env: ON }),
    ).toEqual({
      ok: false,
      status: CHAT_ACTION_DISPATCH_STATUS.UNKNOWN_ACTION,
      action: "nope",
    });
    expect(await dispatchChatAction({ params: {} }, { env: ON })).toMatchObject(
      { status: CHAT_ACTION_DISPATCH_STATUS.UNKNOWN_ACTION, action: "" },
    );
    expect(
      await dispatchChatAction(undefined as never, { env: ON }),
    ).toMatchObject({
      status: CHAT_ACTION_DISPATCH_STATUS.UNKNOWN_ACTION,
      action: "",
    });
  });

  it("runs the params-validator and rejects on failure (with and without an errors array) without invoking the handler", async () => {
    let handlerRan = false;
    registerDemo(
      () => {
        handlerRan = true;
        return "x";
      },
      (params) =>
        (params as { ok2?: boolean } | undefined)?.ok2
          ? { ok: true }
          : { ok: false, errors: ["bad params"] },
    );
    expect(
      await dispatchChatAction(
        { action: "demo", params: { ok2: false } },
        { env: ON },
      ),
    ).toMatchObject({
      ok: false,
      status: CHAT_ACTION_DISPATCH_STATUS.INVALID_PARAMS,
      action: "demo",
      errors: ["bad params"],
    });
    expect(handlerRan).toBe(false);

    clearChatActionRegistry();
    registerDemo(
      () => "x",
      () => undefined as never,
    ); // validator returns a falsy result -> INVALID_PARAMS, errors default []
    expect(
      await dispatchChatAction({ action: "demo", params: {} }, { env: ON }),
    ).toMatchObject({
      status: CHAT_ACTION_DISPATCH_STATUS.INVALID_PARAMS,
      errors: [],
    });

    clearChatActionRegistry();
    registerDemo(
      () => "x",
      () => ({ ok: false }),
    ); // ok:false without an errors array -> errors default []
    expect(
      await dispatchChatAction({ action: "demo", params: {} }, { env: ON }),
    ).toMatchObject({
      status: CHAT_ACTION_DISPATCH_STATUS.INVALID_PARAMS,
      errors: [],
    });
  });

  it("invokes the chokepoint-routed handler on validator pass and returns DISPATCHED", async () => {
    registerDemo(
      () => "performed",
      () => ({ ok: true }),
    );
    const res = await dispatchChatAction(
      { action: "demo", params: { any: 1 } },
      { env: ON },
    );
    expect(res).toMatchObject({
      ok: true,
      status: CHAT_ACTION_DISPATCH_STATUS.DISPATCHED,
      action: "demo",
      result: { ok: true, stage: "allow", result: "performed" },
    });
  });
});
