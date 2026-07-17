// Portfolio release/requeue chat-action registrations (#6838).
//
// Child issue of the chat action-dispatch scaffolding (#6519). Registers `portfolio_release` /
// `portfolio_requeue` into a chat-action registry. Handlers MUST be wired to the miner-ui clients
// `releasePortfolioQueueItem` / `requeuePortfolioQueueItem` (apps/loopover-miner-ui/src/lib/
// portfolio-queue-actions.ts), so chat POSTs the SAME `/api/portfolio-queue/{release,requeue}` routes the
// dashboard's existing buttons already call — never portfolio-queue.js directly, and never a hand-rolled
// fetch. The miner-ui wire module passes those clients in; this module only owns the registration contract
// + params validators. That is what keeps chat from becoming a parallel write path (#6504's design).
//
// Release/requeue is local queue administration, not a chokepoint content-write: the route it lands on is a
// thin bridge to the same store methods the CLI's `queue release` / `queue requeue` already use
// (vite-portfolio-queue-actions-api.ts → reclaimStuckItem / requeueItem), and it invokes no chokepoint of its
// own. Requiring one only for the chat path would gate chat MORE strictly than the button beside it, which
// #6838 forbids ("No changes to the existing route or button-triggered flow"). So, exactly like
// chat-governor-actions.js's administrative pause/resume, we satisfy the registry's `governorGatedHandler`
// brand with an allow-stage evaluateGate rather than routing through governor-chokepoint.js. Execution still
// stays behind the shared LOOPOVER_MINER_CHAT_ACTIONS flag via `dispatchChatAction`.

import { governorGatedHandler, chatActionRegistry } from "./chat-action-registry.js";

export const PORTFOLIO_RELEASE_CHAT_ACTION = "portfolio_release";
export const PORTFOLIO_REQUEUE_CHAT_ACTION = "portfolio_requeue";

/** Local queue administration is not a chokepoint content-write (#6838); satisfy the registry brand only. */
const allowAdministrativeGate = () => ({ decision: { stage: "allow" } });

/**
 * Params for both actions: the queue item to act on. `repoFullName` + `identifier` are required non-empty
 * strings; `apiBaseUrl` is optional (the route defaults it, mirroring the client's own
 * `Pick<PortfolioQueueActionItem, "repoFullName" | "identifier" | "apiBaseUrl">` shape, where the buttons
 * always pass one but the CLI path does not). Unknown keys are rejected rather than ignored: a typo'd param
 * from a model-authored call must fail loudly, not silently act on the wrong item.
 *
 * @param {unknown} params
 * @returns {boolean}
 */
export function isPortfolioItemChatParams(params) {
  if (params == null || typeof params !== "object" || Array.isArray(params)) return false;
  const record = /** @type {Record<string, unknown>} */ (params);
  for (const key of Object.keys(record)) {
    if (key !== "repoFullName" && key !== "identifier" && key !== "apiBaseUrl") return false;
  }
  if (typeof record.repoFullName !== "string" || record.repoFullName.trim() === "") return false;
  if (typeof record.identifier !== "string" || record.identifier.trim() === "") return false;
  if (record.apiBaseUrl !== undefined && typeof record.apiBaseUrl !== "string") return false;
  return true;
}

/**
 * Narrow validated params to the client's item shape. `apiBaseUrl` is only forwarded when present, so an
 * omitted one stays omitted rather than becoming an explicit `undefined` in the POST body.
 *
 * @param {unknown} params
 * @returns {{ repoFullName: string, identifier: string, apiBaseUrl?: string }}
 */
function readPortfolioItem(params) {
  const record = /** @type {{ repoFullName: string, identifier: string, apiBaseUrl?: unknown }} */ (params);
  const item = { repoFullName: record.repoFullName, identifier: record.identifier };
  return typeof record.apiBaseUrl === "string" ? { ...item, apiBaseUrl: record.apiBaseUrl } : item;
}

/**
 * Idempotently register `portfolio_release` / `portfolio_requeue`.
 *
 * @param {{
 *   releaseItem: (item: { repoFullName: string, identifier: string, apiBaseUrl?: string }) => Promise<unknown>,
 *   requeueItem: (item: { repoFullName: string, identifier: string, apiBaseUrl?: string }) => Promise<unknown>,
 *   registry?: import("./chat-action-registry.js").ChatActionRegistry,
 *   evaluateGate?: () => { decision: { stage: string } },
 * }} options
 */
export function registerPortfolioChatActions(options) {
  const releaseItem = options?.releaseItem;
  const requeueItem = options?.requeueItem;
  if (typeof releaseItem !== "function") {
    throw new TypeError("registerPortfolioChatActions: releaseItem must be a function");
  }
  if (typeof requeueItem !== "function") {
    throw new TypeError("registerPortfolioChatActions: requeueItem must be a function");
  }

  const registry = options.registry ?? chatActionRegistry;
  const evaluateGate = options.evaluateGate ?? allowAdministrativeGate;

  if (!registry.has(PORTFOLIO_RELEASE_CHAT_ACTION)) {
    registry.register(PORTFOLIO_RELEASE_CHAT_ACTION, {
      paramsValidator: isPortfolioItemChatParams,
      handler: governorGatedHandler(async (request) => releaseItem(readPortfolioItem(request?.params)), {
        evaluateGate,
      }),
    });
  }

  if (!registry.has(PORTFOLIO_REQUEUE_CHAT_ACTION)) {
    registry.register(PORTFOLIO_REQUEUE_CHAT_ACTION, {
      paramsValidator: isPortfolioItemChatParams,
      handler: governorGatedHandler(async (request) => requeueItem(readPortfolioItem(request?.params)), {
        evaluateGate,
      }),
    });
  }
}
