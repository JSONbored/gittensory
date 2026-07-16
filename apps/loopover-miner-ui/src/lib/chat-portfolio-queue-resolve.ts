// Chat-text → portfolio-queue action resolution (#6520). Pure: no fetch, no dispatch. Parses an operator's
// chat message into one of the two known actions (`portfolio.release` / `portfolio.requeue`) plus a target
// repo (and optional identifier). Ambiguous / malformed text returns an explicit unresolvable result so the
// caller never falls through to a best-guess `dispatchChatAction` call.

export const PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION = "portfolio.release";
export const PORTFOLIO_QUEUE_CHAT_REQUEUE_ACTION = "portfolio.requeue";

export type PortfolioQueueChatActionName =
  typeof PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION | typeof PORTFOLIO_QUEUE_CHAT_REQUEUE_ACTION;

/** Fields the dispatch handler needs; `apiBaseUrl` is filled in after matching a live queue item. */
export type PortfolioQueueChatActionTarget = {
  repoFullName: string;
  /** Present when the operator named an issue/identifier; otherwise the runner matches by repo alone. */
  identifier?: string;
};

export type PortfolioQueueChatResolveResult =
  | { ok: true; action: PortfolioQueueChatActionName; target: PortfolioQueueChatActionTarget }
  | { ok: false; reason: "unresolvable"; message: string };

const ACTION_WORD: Record<string, PortfolioQueueChatActionName> = {
  release: PORTFOLIO_QUEUE_CHAT_RELEASE_ACTION,
  requeue: PORTFOLIO_QUEUE_CHAT_REQUEUE_ACTION,
};

/** `owner/repo` — letters, digits, dots, underscores, hyphens; one slash. */
const REPO_RE = /\b([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)\b/;
/** Optional identifier: `issue:12`, `#12`, or a bare positive integer. */
const IDENTIFIER_RE = /\b(?:issue:(\d+)|#(\d+)|(?<![A-Za-z0-9._/-])(\d+)(?![A-Za-z0-9._/-]))\b/i;

const UNRESOLVABLE =
  'Couldn\'t determine a portfolio-queue action. Say something like "release owner/repo" or "requeue owner/repo #12".';

/**
 * Resolve chat text to a portfolio release/requeue request. Does NOT call the dispatch layer — an
 * unresolvable result must never be turned into a best-guess dispatch.
 */
export function resolvePortfolioQueueChatAction(text: string): PortfolioQueueChatResolveResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "unresolvable", message: UNRESOLVABLE };

  const lower = trimmed.toLowerCase();
  const actionHits = (Object.keys(ACTION_WORD) as Array<keyof typeof ACTION_WORD>).filter((word) => {
    // Word boundary so "prelease" / "requeued" don't match; allow leading verbs ("please release…").
    return new RegExp(`\\b${word}\\b`, "i").test(lower);
  });
  if (actionHits.length !== 1) {
    return { ok: false, reason: "unresolvable", message: UNRESOLVABLE };
  }
  const action = ACTION_WORD[actionHits[0]!]!;

  const repoMatch = trimmed.match(REPO_RE);
  if (!repoMatch?.[1]) {
    return { ok: false, reason: "unresolvable", message: UNRESOLVABLE };
  }
  const repoFullName = repoMatch[1];

  // Strip the matched repo from the remainder so a bare owner segment isn't treated as an identifier.
  const withoutRepo = trimmed.replace(repoMatch[0], " ");
  const idMatch = withoutRepo.match(IDENTIFIER_RE);
  const identifierNum = idMatch?.[1] ?? idMatch?.[2] ?? idMatch?.[3];
  const target: PortfolioQueueChatActionTarget = identifierNum
    ? { repoFullName, identifier: `issue:${identifierNum}` }
    : { repoFullName };

  return { ok: true, action, target };
}
