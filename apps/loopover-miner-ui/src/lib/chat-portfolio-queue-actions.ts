// Portfolio-queue chat action registration + runner (#6520). Registers `portfolio.release` /
// `portfolio.requeue` into the shared (or an injected) chat-action registry, each thin-wrapping
// `releasePortfolioQueueItem` / `requeuePortfolioQueueItem` — the SAME client module the portfolio page
// buttons already use. Every invocation goes through `dispatchChatAction` (flag + registry + params
// validator) and `governorGatedHandler` (chokepoint). No second fetch/POST path, no new API route.

import {
  CHAT_ACTION_DISPATCH_ENABLE_VALUE,
  CHAT_ACTION_DISPATCH_FLAG,
  dispatchChatAction,
} from "../../../../packages/loopover-miner/lib/chat-action-dispatch.js";
import type { ChatActionDispatchResult } from "../../../../packages/loopover-miner/lib/chat-action-dispatch.js";
import {
  governorGatedHandler,
  registerChatAction,
} from "../../../../packages/loopover-miner/lib/chat-action-registry.js";
import type { ChatActionRegistry } from "../../../../packages/loopover-miner/lib/chat-action-registry.js";
import type { ChatMessage } from "../components/chat/fixtures";
import {
  PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION,
  PORTFOLIO_QUEUE_CHAT_REQUEUE_ACTION,
  resolvePortfolioQueueChatAction,
  type PortfolioQueueChatActionName,
  type PortfolioQueueChatActionTarget,
} from "./chat-portfolio-queue-resolve";
import {
  releasePortfolioQueueItem,
  requeuePortfolioQueueItem,
  type PortfolioQueueActionItem,
  type PortfolioQueueActionResult,
  type PortfolioQueueItemsResult,
} from "./portfolio-queue-actions";

export { PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION, PORTFOLIO_QUEUE_CHAT_REQUEUE_ACTION, resolvePortfolioQueueChatAction };

export type PortfolioQueueChatParams = {
  repoFullName: string;
  identifier: string;
  apiBaseUrl: string;
};

function isPortfolioQueueChatParams(params: unknown): params is PortfolioQueueChatParams {
  if (typeof params !== "object" || params === null) return false;
  const row = params as Record<string, unknown>;
  return (
    typeof row.repoFullName === "string" &&
    row.repoFullName.includes("/") &&
    typeof row.identifier === "string" &&
    row.identifier.length > 0 &&
    typeof row.apiBaseUrl === "string" &&
    row.apiBaseUrl.length > 0
  );
}

export type RegisterPortfolioQueueChatActionsOptions = {
  /** Isolated registry for tests; defaults to the shared `registerChatAction` target. */
  registry?: ChatActionRegistry;
  /** Override the Governor gate (tests inject an allow/deny stub). */
  evaluateGate?: (input: unknown, gateOptions?: unknown) => unknown;
  /** Injected fetch so tests never hit the network. */
  fetchImpl?: typeof fetch;
};

let sharedRegistrationDone = false;

/**
 * Register the two portfolio-queue chat actions. Idempotent on the shared registry (safe to call from
 * multiple entry points). When an isolated `registry` is supplied, always registers onto that instance.
 */
export function registerPortfolioQueueChatActions(options: RegisterPortfolioQueueChatActionsOptions = {}): void {
  if (!options.registry && sharedRegistrationDone) return;

  const fetchImpl = options.fetchImpl ?? fetch;
  const gateOpts = options.evaluateGate ? { evaluateGate: options.evaluateGate } : undefined;

  const releaseHandler = governorGatedHandler(async (request) => {
    const params = request.params as PortfolioQueueChatParams;
    return releasePortfolioQueueItem(params, fetchImpl);
  }, gateOpts);

  const requeueHandler = governorGatedHandler(async (request) => {
    const params = request.params as PortfolioQueueChatParams;
    return requeuePortfolioQueueItem(params, fetchImpl);
  }, gateOpts);

  const definitionFor = (handler: ReturnType<typeof governorGatedHandler>) => ({
    paramsValidator: isPortfolioQueueChatParams,
    handler,
  });

  const register = options.registry
    ? (name: string, definition: Parameters<ChatActionRegistry["register"]>[1]) =>
        options.registry!.register(name, definition)
    : registerChatAction;

  register(PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION, definitionFor(releaseHandler));
  register(PORTFOLIO_QUEUE_CHAT_REQUEUE_ACTION, definitionFor(requeueHandler));

  if (!options.registry) sharedRegistrationDone = true;
}

/** Test-only: reset the shared-registry once-flag so a later registration can run again. */
export function resetPortfolioQueueChatActionsRegistrationForTest(): void {
  sharedRegistrationDone = false;
}

export type MatchPortfolioQueueChatTargetResult =
  { ok: true; item: PortfolioQueueActionItem } | { ok: false; message: string };

/**
 * Match a resolved chat target against live actionable queue items. Release only matches `in_progress`;
 * requeue only matches `done` — same rules the portfolio table buttons enforce.
 */
export function matchPortfolioQueueChatTarget(
  action: PortfolioQueueChatActionName,
  target: PortfolioQueueChatActionTarget,
  itemsResult: PortfolioQueueItemsResult,
): MatchPortfolioQueueChatTargetResult {
  if (!itemsResult.ok) {
    return { ok: false, message: `Couldn't determine a portfolio-queue target: ${itemsResult.error}` };
  }
  const wantedStatus = action === PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION ? "in_progress" : "done";
  const repoKey = target.repoFullName.toLowerCase();
  const matches = itemsResult.items.filter((item) => {
    if (item.repoFullName.toLowerCase() !== repoKey) return false;
    if (item.status !== wantedStatus) return false;
    if (target.identifier && item.identifier !== target.identifier) return false;
    return true;
  });
  if (matches.length === 0) {
    return {
      ok: false,
      message: `Couldn't determine a portfolio-queue target: no ${wantedStatus.replace("_", "-")} item matched ${target.repoFullName}${target.identifier ? ` (${target.identifier})` : ""}.`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `Couldn't determine a portfolio-queue target: ${matches.length} items matched ${target.repoFullName}; name an identifier (e.g. #12).`,
    };
  }
  return { ok: true, item: matches[0]! };
}

type GovernorHandlerResult = {
  ok: boolean;
  status: string;
  result?: PortfolioQueueActionResult;
};

function readHandlerResult(dispatch: ChatActionDispatchResult): GovernorHandlerResult | undefined {
  if (!dispatch.ok || dispatch.status !== "dispatched") return undefined;
  const inner = dispatch.result;
  if (!inner || typeof inner !== "object") return undefined;
  return inner as GovernorHandlerResult;
}

/** Format a dispatch / match outcome as a system chat message for the message list (#6515 / #6520). */
export function formatPortfolioQueueChatResultMessage(input: {
  id: string;
  timestamp: string;
  action: PortfolioQueueChatActionName | null;
  item?: Pick<PortfolioQueueActionItem, "repoFullName" | "identifier"> | undefined;
  dispatch?: ChatActionDispatchResult | undefined;
  errorMessage?: string | undefined;
}): ChatMessage {
  const verb = input.action === PORTFOLIO_QUEUE_CHAT_REQUEUE_ACTION ? "requeue" : "release";
  const targetLabel = input.item ? `${input.item.repoFullName} (${input.item.identifier})` : null;

  if (input.errorMessage) {
    return { id: input.id, role: "system", content: input.errorMessage, timestamp: input.timestamp };
  }

  if (input.dispatch && !input.dispatch.ok) {
    const detail =
      input.dispatch.status === "disabled"
        ? "Chat actions are disabled (set LOOPOVER_MINER_CHAT_ACTIONS=enabled to allow them)."
        : input.dispatch.status === "invalid_params"
          ? `Couldn't ${verb}: invalid parameters.`
          : input.dispatch.status === "unknown_action"
            ? `Couldn't ${verb}: action is not registered.`
            : `Couldn't ${verb}: ${input.dispatch.status}.`;
    return { id: input.id, role: "system", content: detail, timestamp: input.timestamp };
  }

  const handler = input.dispatch ? readHandlerResult(input.dispatch) : undefined;
  if (handler && handler.ok === false && handler.status === "gated") {
    return {
      id: input.id,
      role: "system",
      content: `Governor blocked the ${verb} for ${targetLabel ?? "the target"}.`,
      timestamp: input.timestamp,
    };
  }

  const write = handler?.result;
  if (write && !write.ok) {
    return {
      id: input.id,
      role: "system",
      content: `Queue ${verb} failed for ${targetLabel ?? "the target"}: ${write.error}`,
      timestamp: input.timestamp,
    };
  }
  if (write?.ok) {
    return {
      id: input.id,
      role: "system",
      content: `Queue ${verb} succeeded for ${write.entry.repoFullName} (${write.entry.identifier}) — status is now ${write.entry.status}.`,
      timestamp: input.timestamp,
    };
  }

  return {
    id: input.id,
    role: "system",
    content: targetLabel ? `Queue ${verb} dispatched for ${targetLabel}.` : `Queue ${verb} dispatched.`,
    timestamp: input.timestamp,
  };
}

export type HandlePortfolioQueueChatCommandDeps = {
  env?: Record<string, string | undefined>;
  registry?: ChatActionRegistry;
  /** Load actionable queue rows (defaults to the live items API via the registration's fetchImpl path). */
  loadItems: () => Promise<PortfolioQueueItemsResult>;
  /** Build Governor chokepoint input for the matched item. */
  buildGovernorInput: (item: PortfolioQueueActionItem, action: PortfolioQueueChatActionName) => unknown;
  nowIso?: () => string;
  newId?: () => string;
  evaluateGate?: (input: unknown, gateOptions?: unknown) => unknown;
  fetchImpl?: typeof fetch;
};

export type HandlePortfolioQueueChatCommandResult = {
  /** Messages to append to the chat list (user echo is the caller's job; this returns system outcomes). */
  messages: ChatMessage[];
  /** True only when `dispatchChatAction` was invoked. */
  dispatched: boolean;
};

/**
 * End-to-end chat command handler for portfolio release/requeue (#6520): resolve → match → dispatch →
 * message-list entry. An unresolvable / ambiguous instruction never reaches the dispatch layer.
 */
export async function handlePortfolioQueueChatCommand(
  text: string,
  deps: HandlePortfolioQueueChatCommandDeps,
): Promise<HandlePortfolioQueueChatCommandResult> {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const stamp = nowIso();

  const resolved = resolvePortfolioQueueChatAction(text);
  if (!resolved.ok) {
    return {
      dispatched: false,
      messages: [{ id: newId(), role: "system", content: resolved.message, timestamp: stamp }],
    };
  }

  const items = await deps.loadItems();
  const matched = matchPortfolioQueueChatTarget(resolved.action, resolved.target, items);
  if (!matched.ok) {
    return {
      dispatched: false,
      messages: [{ id: newId(), role: "system", content: matched.message, timestamp: stamp }],
    };
  }

  registerPortfolioQueueChatActions({
    ...(deps.registry ? { registry: deps.registry } : {}),
    evaluateGate: deps.evaluateGate,
    fetchImpl: deps.fetchImpl,
  });

  const env = deps.env ?? { [CHAT_ACTION_DISPATCH_FLAG]: CHAT_ACTION_DISPATCH_ENABLE_VALUE };
  const params: PortfolioQueueChatParams = {
    repoFullName: matched.item.repoFullName,
    identifier: matched.item.identifier,
    apiBaseUrl: matched.item.apiBaseUrl,
  };

  const dispatch = await dispatchChatAction(
    {
      action: resolved.action,
      params,
      governorInput: deps.buildGovernorInput(matched.item, resolved.action),
    },
    { env, ...(deps.registry ? { registry: deps.registry } : {}) },
  );

  return {
    dispatched: true,
    messages: [
      formatPortfolioQueueChatResultMessage({
        id: newId(),
        timestamp: stamp,
        action: resolved.action,
        item: matched.item,
        dispatch,
      }),
    ],
  };
}
