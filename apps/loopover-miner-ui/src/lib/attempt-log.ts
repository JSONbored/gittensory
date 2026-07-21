// Read-only client for the local attempt-log API (#7656). The middleware aggregates the miner's per-attempt event
// log and its PR-outcome records server-side into action/type/decision counts plus a small feed of SAFE columns —
// it never republishes the attempt log's raw `payload` or any secret-shaped value (the same invariant the sibling
// ledgers client and the read-only MCP tools enforce). This client just fetches that summary and validates its
// shape; a failure surfaces as a typed error result the view renders, never a crash.

import { DEMO_ATTEMPT_LOG_SUMMARY, isDemoMode } from "./demo-data";

export const ATTEMPT_LOG_API_PATH = "/api/attempt-log";

export const PR_OUTCOME_DECISIONS = ["merged", "closed"] as const;
export type PrOutcomeDecision = (typeof PR_OUTCOME_DECISIONS)[number];

export type AttemptFeedEntry = {
  attemptId: string;
  eventType: string;
  actionClass: string;
  provider: string | null;
  costUsd: number | null;
  tokensUsed: number | null;
  createdAt: string | null;
};
export type PrOutcomeFeedEntry = {
  repoFullName: string | null;
  prNumber: number | null;
  decision: PrOutcomeDecision;
  reason: string | null;
  closedAt: string | null;
};
export type AttemptsSummary = {
  total: number;
  byActionClass: Record<string, number>;
  byEventType: Record<string, number>;
  totalCostUsd: number | null;
  recent: AttemptFeedEntry[];
};
export type PrOutcomesSummary = {
  total: number;
  byDecision: Record<PrOutcomeDecision, number>;
  byReason: Record<string, number>;
  recent: PrOutcomeFeedEntry[];
};
export type AttemptLogSummary = { attempts: AttemptsSummary; prOutcomes: PrOutcomesSummary };

export type AttemptLogResult = { ok: true; summary: AttemptLogSummary } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCountMap(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((count) => typeof count === "number");
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isAttemptFeedEntry(value: unknown): value is AttemptFeedEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.attemptId === "string" &&
    typeof value.eventType === "string" &&
    typeof value.actionClass === "string" &&
    isNullableString(value.provider) &&
    isNullableNumber(value.costUsd) &&
    isNullableNumber(value.tokensUsed) &&
    isNullableString(value.createdAt)
  );
}

function isPrOutcomeFeedEntry(value: unknown): value is PrOutcomeFeedEntry {
  if (!isRecord(value)) return false;
  return (
    isNullableString(value.repoFullName) &&
    isNullableNumber(value.prNumber) &&
    (value.decision === "merged" || value.decision === "closed") &&
    isNullableString(value.reason) &&
    isNullableString(value.closedAt)
  );
}

function isAttemptsSummary(value: unknown): value is AttemptsSummary {
  if (!isRecord(value)) return false;
  return (
    typeof value.total === "number" &&
    isCountMap(value.byActionClass) &&
    isCountMap(value.byEventType) &&
    isNullableNumber(value.totalCostUsd) &&
    Array.isArray(value.recent) &&
    value.recent.every(isAttemptFeedEntry)
  );
}

function isPrOutcomesSummary(value: unknown): value is PrOutcomesSummary {
  if (!isRecord(value)) return false;
  const byDecision = value.byDecision;
  return (
    typeof value.total === "number" &&
    isRecord(byDecision) &&
    typeof byDecision.merged === "number" &&
    typeof byDecision.closed === "number" &&
    isCountMap(value.byReason) &&
    Array.isArray(value.recent) &&
    value.recent.every(isPrOutcomeFeedEntry)
  );
}

function isAttemptLogSummary(value: unknown): value is AttemptLogSummary {
  if (!isRecord(value)) return false;
  return isAttemptsSummary(value.attempts) && isPrOutcomesSummary(value.prOutcomes);
}

/** Fetch the local attempt-log summary; failures surface as a typed error result the view renders, never a crash. */
export async function fetchAttemptLog(fetchImpl: typeof fetch = fetch): Promise<AttemptLogResult> {
  if (isDemoMode()) return { ok: true, summary: DEMO_ATTEMPT_LOG_SUMMARY };
  try {
    const response = await fetchImpl(ATTEMPT_LOG_API_PATH);
    if (!response.ok) return { ok: false, error: `local attempt-log API responded ${response.status}` };
    const payload: unknown = await response.json();
    const summary = (payload as { summary?: unknown }).summary;
    if (!isAttemptLogSummary(summary))
      return { ok: false, error: "local attempt-log API returned an unexpected payload shape" };
    return { ok: true, summary };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "failed to reach the local attempt-log API" };
  }
}
