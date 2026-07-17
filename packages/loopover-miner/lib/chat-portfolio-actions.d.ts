import type { ChatActionRegistry } from "./chat-action-registry.js";

export const PORTFOLIO_RELEASE_CHAT_ACTION: "portfolio_release";
export const PORTFOLIO_REQUEUE_CHAT_ACTION: "portfolio_requeue";

export type PortfolioChatActionItem = {
  repoFullName: string;
  identifier: string;
  apiBaseUrl?: string;
};

export function isPortfolioItemChatParams(params: unknown): boolean;

export function registerPortfolioChatActions(options: {
  releaseItem: (item: PortfolioChatActionItem) => Promise<unknown>;
  requeueItem: (item: PortfolioChatActionItem) => Promise<unknown>;
  registry?: ChatActionRegistry;
  evaluateGate?: () => { decision: { stage: string } };
}): void;
