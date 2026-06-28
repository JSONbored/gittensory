import { extractPayloadType } from "./audit";

// Webhook-driven work (a fresh PR -> its review) jumps ahead of heavy background jobs. Per-PR review refreshes
// sit just below real webhooks, and sweep fan-out sits below those so stale surfaces are repaired during bursts.
// Bot-generated comment edits are background noise; keeping them with real webhooks lets panel edits starve repair.
const PRIORITY_BY_TYPE = new Map([
  ["agent-regate-pr", 9],
  ["recapture-preview", 9],
  ["agent-regate-sweep", 8],
]);

export function jobPriority(payload: string): number {
  const type = extractPayloadType(payload) ?? "";
  if (type === "github-webhook") return githubWebhookPriority(payload);
  return PRIORITY_BY_TYPE.get(type) ?? 0;
}

function githubWebhookPriority(payload: string): number {
  try {
    const message = JSON.parse(payload) as {
      eventName?: unknown;
      payload?: {
        action?: unknown;
        sender?: { login?: unknown; type?: unknown } | null;
      } | null;
    };
    const eventName = typeof message.eventName === "string" ? message.eventName : "";
    const action = typeof message.payload?.action === "string" ? message.payload.action : "";
    const senderLogin =
      typeof message.payload?.sender?.login === "string"
        ? message.payload.sender.login.toLowerCase()
        : "";
    const senderType =
      typeof message.payload?.sender?.type === "string"
        ? message.payload.sender.type.toLowerCase()
        : "";
    if (
      eventName === "issue_comment" &&
      action === "edited" &&
      (senderType === "bot" || senderLogin.endsWith("[bot]"))
    )
      return 0;
  } catch {
    return 0;
  }
  return 10;
}

const DEFAULT_GITHUB_RATE_LIMIT_RETRY_MS = 5 * 60_000;
const MAX_GITHUB_RATE_LIMIT_RETRY_MS = 65 * 60_000;

export function githubRateLimitRetryDelayMs(
  error: unknown,
  nowMs = Date.now(),
): number | null {
  if (typeof error !== "object" || error === null) return null;
  const err = error as {
    status?: unknown;
    message?: unknown;
    response?: { headers?: Headers | Record<string, unknown> | null } | null;
  };
  const status = typeof err.status === "number" ? err.status : null;
  const message = typeof err.message === "string" ? err.message : "";
  const headers = err.response?.headers ?? null;
  const retryAfter = numberHeader(headers, "retry-after");
  if (retryAfter !== null)
    return clampRetryDelay(retryAfter * 1000);

  const remaining = stringHeader(headers, "x-ratelimit-remaining");
  const reset = numberHeader(headers, "x-ratelimit-reset");
  if (remaining === "0" && reset !== null) {
    const delay = reset * 1000 - nowMs + 5_000;
    return clampRetryDelay(delay);
  }

  if (
    (status === 403 || status === 429 || status === null) &&
    /secondary rate limit|\babuse\b|api rate limit exceeded|rate limit/i.test(
      message,
    )
  )
    return DEFAULT_GITHUB_RATE_LIMIT_RETRY_MS;

  return null;
}

function clampRetryDelay(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return DEFAULT_GITHUB_RATE_LIMIT_RETRY_MS;
  return Math.min(Math.ceil(delayMs), MAX_GITHUB_RATE_LIMIT_RETRY_MS);
}

function numberHeader(
  headers: Headers | Record<string, unknown> | null,
  key: string,
): number | null {
  const raw = stringHeader(headers, key);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringHeader(
  headers: Headers | Record<string, unknown> | null,
  key: string,
): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    const value = (headers as Headers).get(key);
    return value === null ? null : String(value);
  }
  const value =
    (headers as Record<string, unknown>)[key] ??
    (headers as Record<string, unknown>)[key.toLowerCase()];
  return value == null ? null : String(value);
}
