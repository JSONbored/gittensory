import type { Plugin } from "vite";

// Registers governor pause/resume chat actions into the shared registry on dev-server start (#6521).
// Handlers call the existing miner-ui `pauseGovernor` / `resumeGovernor` clients — same path as the Ledgers
// buttons. No new /api/governor/* route is added here.

export function chatGovernorActionsPlugin(): Plugin {
  return {
    name: "loopover-miner-chat-governor-actions",
    configureServer() {
      void import("./src/lib/chat-governor-actions").then((mod) => {
        mod.registerGovernorChatActions();
      });
    },
  };
}
