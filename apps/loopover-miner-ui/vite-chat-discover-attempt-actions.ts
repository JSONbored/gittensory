import type { Plugin } from "vite";

// Registers discover/attempt chat actions into the shared registry on dev-server start (#7076).
// Handlers call the existing miner-ui `requestDiscover` / `requestAttempt` clients (POST /api/discover,
// /api/attempt) — no new route is added here.

export function chatDiscoverAttemptActionsPlugin(): Plugin {
  return {
    name: "loopover-miner-chat-discover-attempt-actions",
    configureServer() {
      void import("./src/lib/chat-discover-attempt-actions").then((mod) => {
        mod.registerDiscoverAttemptChatActions();
      });
    },
  };
}
