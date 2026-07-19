import { describe, expect, it, vi } from "vitest";

// The plugin dynamically imports this module by the same relative path it resolves to from here
// (apps/loopover-miner-ui/vite-chat-governor-actions.ts's `./src/lib/chat-governor-actions` and this test's
// `./lib/chat-governor-actions` both resolve to src/lib/chat-governor-actions.ts) — mocking it here intercepts
// the plugin's own dynamic import.
const h = vi.hoisted(() => ({ registerGovernorChatActions: vi.fn() }));
vi.mock("./lib/chat-governor-actions", () => ({ registerGovernorChatActions: h.registerGovernorChatActions }));

import { chatGovernorActionsPlugin } from "../vite-chat-governor-actions";

// #7228: `vite preview` (the systemd-deployed persistent-service path per the README) only ever invokes
// configurePreviewServer, never configureServer — proves the registration call also fires from that hook.
describe("chatGovernorActionsPlugin (#6521, #7228)", () => {
  it("registers a configureServer and a configurePreviewServer hook", () => {
    const plugin = chatGovernorActionsPlugin();
    expect(typeof plugin.configureServer).toBe("function");
    expect(typeof plugin.configurePreviewServer).toBe("function");
  });

  it("invokes registerGovernorChatActions when only configurePreviewServer is exercised", async () => {
    h.registerGovernorChatActions.mockClear();
    const plugin = chatGovernorActionsPlugin();
    // @ts-expect-error -- configurePreviewServer's registration call reads no properties off its server arg.
    plugin.configurePreviewServer?.();
    await vi.waitFor(() => expect(h.registerGovernorChatActions).toHaveBeenCalledTimes(1));
  });

  it("invokes registerGovernorChatActions when configureServer is exercised (unchanged behavior)", async () => {
    h.registerGovernorChatActions.mockClear();
    const plugin = chatGovernorActionsPlugin();
    // @ts-expect-error -- configureServer's registration call reads no properties off its server arg.
    plugin.configureServer?.();
    await vi.waitFor(() => expect(h.registerGovernorChatActions).toHaveBeenCalledTimes(1));
  });
});
