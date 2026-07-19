import { describe, expect, it, vi } from "vitest";

// The plugin dynamically imports this module by the same relative path it resolves to from here
// (apps/loopover-miner-ui/vite-chat-discover-attempt-actions.ts's `./src/lib/chat-discover-attempt-actions`
// and this test's `./lib/chat-discover-attempt-actions` both resolve to src/lib/chat-discover-attempt-actions.ts)
// — mocking it here intercepts the plugin's own dynamic import.
const h = vi.hoisted(() => ({ registerDiscoverAttemptChatActions: vi.fn() }));
vi.mock("./lib/chat-discover-attempt-actions", () => ({
  registerDiscoverAttemptChatActions: h.registerDiscoverAttemptChatActions,
}));

import { chatDiscoverAttemptActionsPlugin } from "../vite-chat-discover-attempt-actions";

// #7228: `vite preview` (the systemd-deployed persistent-service path per the README) only ever invokes
// configurePreviewServer, never configureServer — proves the registration call also fires from that hook.
describe("chatDiscoverAttemptActionsPlugin (#6837, #7228)", () => {
  it("registers a configureServer and a configurePreviewServer hook", () => {
    const plugin = chatDiscoverAttemptActionsPlugin();
    expect(typeof plugin.configureServer).toBe("function");
    expect(typeof plugin.configurePreviewServer).toBe("function");
  });

  it("invokes registerDiscoverAttemptChatActions when only configurePreviewServer is exercised", async () => {
    h.registerDiscoverAttemptChatActions.mockClear();
    const plugin = chatDiscoverAttemptActionsPlugin();
    // @ts-expect-error -- configurePreviewServer's registration call reads no properties off its server arg.
    plugin.configurePreviewServer?.();
    await vi.waitFor(() => expect(h.registerDiscoverAttemptChatActions).toHaveBeenCalledTimes(1));
  });

  it("invokes registerDiscoverAttemptChatActions when configureServer is exercised (unchanged behavior)", async () => {
    h.registerDiscoverAttemptChatActions.mockClear();
    const plugin = chatDiscoverAttemptActionsPlugin();
    // @ts-expect-error -- configureServer's registration call reads no properties off its server arg.
    plugin.configureServer?.();
    await vi.waitFor(() => expect(h.registerDiscoverAttemptChatActions).toHaveBeenCalledTimes(1));
  });
});
