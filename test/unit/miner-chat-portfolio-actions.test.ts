import { describe, expect, it, vi } from "vitest";

// governor-chokepoint.js (imported transitively by chat-action-registry.js) pulls in @loopover/engine, whose
// dist is not built in the test workspace -- resolve it against source, matching the sibling miner tests.
vi.mock("@loopover/engine", async () => {
  return import("../../packages/loopover-engine/src/index");
});

import {
  CHAT_ACTION_DISPATCH_ENABLE_VALUE,
  CHAT_ACTION_DISPATCH_FLAG,
  dispatchChatAction,
} from "../../packages/loopover-miner/lib/chat-action-dispatch.js";
import { chatActionRegistry, createChatActionRegistry } from "../../packages/loopover-miner/lib/chat-action-registry.js";
import {
  isPortfolioItemChatParams,
  PORTFOLIO_RELEASE_CHAT_ACTION,
  PORTFOLIO_REQUEUE_CHAT_ACTION,
  registerPortfolioChatActions,
} from "../../packages/loopover-miner/lib/chat-portfolio-actions.js";

const enabledEnv = { [CHAT_ACTION_DISPATCH_FLAG]: CHAT_ACTION_DISPATCH_ENABLE_VALUE };

const item = { repoFullName: "acme/widgets", identifier: "issue:12", apiBaseUrl: "https://api.github.com" };
const released = { ok: true, entry: { repoFullName: "acme/widgets", identifier: "issue:12", status: "queued" } };

type ChatItem = { repoFullName: string; identifier: string; apiBaseUrl?: string };

function setup(over: Partial<Parameters<typeof registerPortfolioChatActions>[0]> = {}) {
  const registry = createChatActionRegistry();
  // Typed params (rather than `vi.fn(async () => …)`) so `mock.calls[0][0]` is a real, inspectable argument --
  // the untyped form infers a zero-length tuple and the forwarded item can't be asserted on.
  const releaseItem = vi.fn(async (_item: ChatItem) => released);
  const requeueItem = vi.fn(async (_item: ChatItem) => released);
  registerPortfolioChatActions({ registry, releaseItem, requeueItem, ...over });
  return { registry, releaseItem, requeueItem };
}

describe("isPortfolioItemChatParams (#6838)", () => {
  it("accepts a full item and an item without the optional apiBaseUrl", () => {
    expect(isPortfolioItemChatParams(item)).toBe(true);
    expect(isPortfolioItemChatParams({ repoFullName: "acme/widgets", identifier: "issue:12" })).toBe(true);
  });

  it("rejects a missing, non-object, or array params value", () => {
    // Unlike governor pause/resume, these actions have REQUIRED params: there is no sensible default item to
    // act on, so nullish must not silently resolve to one.
    expect(isPortfolioItemChatParams(null)).toBe(false);
    expect(isPortfolioItemChatParams(undefined)).toBe(false);
    expect(isPortfolioItemChatParams("acme/widgets")).toBe(false);
    expect(isPortfolioItemChatParams([item])).toBe(false);
  });

  it("rejects a missing or empty repoFullName / identifier", () => {
    expect(isPortfolioItemChatParams({ identifier: "issue:12" })).toBe(false);
    expect(isPortfolioItemChatParams({ repoFullName: "acme/widgets" })).toBe(false);
    expect(isPortfolioItemChatParams({ repoFullName: "", identifier: "issue:12" })).toBe(false);
    expect(isPortfolioItemChatParams({ repoFullName: "acme/widgets", identifier: "   " })).toBe(false);
  });

  it("rejects a non-string repoFullName / identifier / apiBaseUrl", () => {
    expect(isPortfolioItemChatParams({ repoFullName: 42, identifier: "issue:12" })).toBe(false);
    expect(isPortfolioItemChatParams({ repoFullName: "acme/widgets", identifier: 12 })).toBe(false);
    expect(isPortfolioItemChatParams({ ...item, apiBaseUrl: 42 })).toBe(false);
  });

  it("rejects an unknown key rather than ignoring it", () => {
    // A model-authored call that typos a param must fail loudly, not act on a different item than intended.
    expect(isPortfolioItemChatParams({ ...item, status: "done" })).toBe(false);
    expect(isPortfolioItemChatParams({ ...item, repo_full_name: "acme/other" })).toBe(false);
  });
});

describe("registerPortfolioChatActions (#6838)", () => {
  it("registers both actions on the supplied registry", () => {
    const { registry } = setup();
    expect(registry.names().sort()).toEqual([PORTFOLIO_RELEASE_CHAT_ACTION, PORTFOLIO_REQUEUE_CHAT_ACTION].sort());
  });

  it("throws when releaseItem or requeueItem is not a function", () => {
    const registry = createChatActionRegistry();
    expect(() => registerPortfolioChatActions({ registry, requeueItem: async () => released } as never)).toThrow(
      "releaseItem must be a function",
    );
    expect(() => registerPortfolioChatActions({ registry, releaseItem: async () => released } as never)).toThrow(
      "requeueItem must be a function",
    );
  });

  it("is idempotent: a second registration does not throw on the already-registered name", () => {
    const { registry, releaseItem, requeueItem } = setup();
    expect(() => registerPortfolioChatActions({ registry, releaseItem, requeueItem })).not.toThrow();
    expect(registry.size).toBe(2);
  });

  it("falls back to the shared chatActionRegistry when no registry is supplied", () => {
    // The production wiring omits `registry`, so this nullish default is the path that actually ships -- every
    // other test here injects an isolated registry and would never exercise it.
    expect(chatActionRegistry.has(PORTFOLIO_RELEASE_CHAT_ACTION)).toBe(false);
    registerPortfolioChatActions({ releaseItem: async () => released, requeueItem: async () => released });
    expect(chatActionRegistry.has(PORTFOLIO_RELEASE_CHAT_ACTION)).toBe(true);
    expect(chatActionRegistry.has(PORTFOLIO_REQUEUE_CHAT_ACTION)).toBe(true);
  });

  it("registers handlers the registry accepts as governor-gated", () => {
    // The registry rejects any raw handler, so a successful register() IS the proof the brand is present.
    const { registry } = setup();
    expect(registry.has(PORTFOLIO_RELEASE_CHAT_ACTION)).toBe(true);
    expect(registry.has(PORTFOLIO_REQUEUE_CHAT_ACTION)).toBe(true);
  });
});

describe("portfolio chat actions through dispatchChatAction (#6838)", () => {
  it("releases via the injected miner-ui client, forwarding the exact item", async () => {
    const { registry, releaseItem, requeueItem } = setup();
    const result = await dispatchChatAction(
      { action: PORTFOLIO_RELEASE_CHAT_ACTION, params: item },
      { registry, env: enabledEnv },
    );
    // dispatchChatAction wraps the handler's own result: the outer envelope reports the dispatch, the inner
    // one reports the gate verdict + the client's return value.
    expect(result).toMatchObject({ ok: true, status: "dispatched", action: PORTFOLIO_RELEASE_CHAT_ACTION });
    expect(result.result).toMatchObject({ ok: true, status: "executed", result: released });
    // Routed through the client that POSTs /api/portfolio-queue/release -- never the store directly.
    expect(releaseItem).toHaveBeenCalledWith(item);
    expect(requeueItem).not.toHaveBeenCalled();
  });

  it("requeues via the injected miner-ui client", async () => {
    const { registry, releaseItem, requeueItem } = setup();
    await dispatchChatAction({ action: PORTFOLIO_REQUEUE_CHAT_ACTION, params: item }, { registry, env: enabledEnv });
    expect(requeueItem).toHaveBeenCalledWith(item);
    expect(releaseItem).not.toHaveBeenCalled();
  });

  it("omits apiBaseUrl from the forwarded item when it was not supplied", async () => {
    // Not passed as an explicit `undefined`: the client spreads the item into the POST body, so a stray key
    // would serialize as `"apiBaseUrl": undefined` and change the request the buttons already send.
    const { registry, releaseItem } = setup();
    await dispatchChatAction(
      { action: PORTFOLIO_RELEASE_CHAT_ACTION, params: { repoFullName: "acme/widgets", identifier: "issue:12" } },
      { registry, env: enabledEnv },
    );
    // toHaveBeenCalledWith uses toEqual semantics, which treat an explicit `undefined` key as absent -- so the
    // key list is asserted directly, since that is the exact thing this test exists to pin.
    expect(Object.keys(releaseItem.mock.calls[0]![0])).toEqual(["repoFullName", "identifier"]);
  });

  it("does not run the client when the shared action flag is off", async () => {
    const { registry, releaseItem } = setup();
    const result = await dispatchChatAction({ action: PORTFOLIO_RELEASE_CHAT_ACTION, params: item }, { registry, env: {} });
    expect(result).toMatchObject({ ok: false });
    expect(releaseItem).not.toHaveBeenCalled();
  });

  it("does not run the client when params fail validation", async () => {
    const { registry, releaseItem } = setup();
    const result = await dispatchChatAction(
      { action: PORTFOLIO_RELEASE_CHAT_ACTION, params: { repoFullName: "acme/widgets" } },
      { registry, env: enabledEnv },
    );
    expect(result).toMatchObject({ ok: false });
    expect(releaseItem).not.toHaveBeenCalled();
  });

  it("does not run the client when the gate denies", async () => {
    // The registry's brand guarantees every handler consults a gate first; a non-allow stage must short-circuit
    // BEFORE the write, not report a gated result after performing it.
    const { registry, releaseItem } = setup({ evaluateGate: () => ({ decision: { stage: "deny" } }) });
    const result = await dispatchChatAction(
      { action: PORTFOLIO_RELEASE_CHAT_ACTION, params: item },
      { registry, env: enabledEnv },
    );
    // The dispatch itself still succeeds -- it is the HANDLER's inner result that reports the refusal.
    expect(result.result).toMatchObject({ ok: false, status: "gated", decision: { stage: "deny" } });
    expect(releaseItem).not.toHaveBeenCalled();
  });
});
