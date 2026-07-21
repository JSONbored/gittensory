import { existsSync } from "node:fs";
import type { Plugin } from "vite";

// Local read-only attempt-log + PR-outcome API (#7656) — sibling of `vite-ledgers-api.ts` / `vite-run-state-api.ts`,
// same shape and same reason: the dashboard is a browser app while the miner's per-attempt event log
// (`attempt-log.sqlite3`) and its own PR-outcome records (recorded INTO the event ledger) are `node:sqlite` files on
// disk, so the dev server bridges the two by calling into the EXISTING read exports of
// `packages/loopover-miner/lib/{attempt-log,event-ledger,pr-outcome}.js`.
//
// SAFETY: both stores are aggregated SERVER-SIDE to action/type/decision COUNTS plus a small feed of
// explicitly-projected SAFE columns. The attempt log's free-form `payload` (a per-event blob that can carry a
// coding-agent tool call's raw arguments) NEVER crosses the wire — only the fixed, non-free-text columns
// (attemptId, eventType, actionClass, provider, costUsd, tokensUsed, createdAt) are projected. That is the same "no
// raw payload, safe columns only" invariant the sibling ledgers endpoint and the read-only MCP tools enforce (#5199).
//
// Same read-only fresh-install rule as the sibling endpoints: the default `read*` exports lazily initialize their
// store, which would CREATE the SQLite file — so each store's resolved DB path is probed first and reported empty
// without ever touching the store when no DB exists yet.

const RECENT_EVENT_LIMIT = 25;

export const PR_OUTCOME_DECISIONS = ["merged", "closed"] as const;
type PrOutcomeDecision = (typeof PR_OUTCOME_DECISIONS)[number];

// Raw store rows are read defensively through `unknown` fields (mirrors vite-ledgers-api.ts): only the projected
// columns below are ever touched, so an unexpected extra field — including the excluded `payload` — is structurally
// dropped rather than trusted.
type AttemptLogRow = {
  eventType?: unknown;
  attemptId?: unknown;
  actionClass?: unknown;
  provider?: unknown;
  costUsd?: unknown;
  tokensUsed?: unknown;
  createdAt?: unknown;
};
type PrOutcomeRecord = {
  repoFullName?: unknown;
  prNumber?: unknown;
  decision?: unknown;
  reason?: unknown;
  closedAt?: unknown;
};

type AttemptLogModule = {
  resolveAttemptLogDbPath: () => string;
  readAttemptLogEvents: (filter?: unknown) => AttemptLogRow[];
};
type EventLedgerModule = { resolveEventLedgerDbPath: () => string; readEvents: (filter?: unknown) => unknown[] };
type PrOutcomeModule = {
  readPrOutcomes: (
    reader: { readEvents: (filter?: unknown) => unknown[] },
    filter?: unknown,
  ) => Map<string, PrOutcomeRecord>;
};

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

export function emptyAttemptLogSummary(): AttemptLogSummary {
  return {
    attempts: { total: 0, byActionClass: {}, byEventType: {}, totalCostUsd: null, recent: [] },
    prOutcomes: { total: 0, byDecision: { merged: 0, closed: 0 }, byReason: {}, recent: [] },
  };
}

const asString = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null);
const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function summarizeAttempts(rows: AttemptLogRow[]): AttemptsSummary {
  const byActionClass: Record<string, number> = {};
  const byEventType: Record<string, number> = {};
  // Null (not 0) when no event carried a real cost — never fabricated (mirrors attempt-log.ts's own costUsd
  // contract). `hasCost` separates "no cost-bearing event" (→ null) from "cost-bearing events summing to 0".
  let costTotal = 0;
  let hasCost = false;
  for (const row of rows) {
    const actionClass = asString(row.actionClass);
    if (actionClass) byActionClass[actionClass] = (byActionClass[actionClass] ?? 0) + 1;
    const eventType = asString(row.eventType);
    if (eventType) byEventType[eventType] = (byEventType[eventType] ?? 0) + 1;
    const cost = asNumber(row.costUsd);
    if (cost !== null) {
      costTotal += cost;
      hasCost = true;
    }
  }
  // Newest-first, capped — and projected to SAFE columns only (never the raw payload).
  const recent = rows
    .slice(-RECENT_EVENT_LIMIT)
    .reverse()
    .map((row) => ({
      attemptId: asString(row.attemptId) ?? "unknown",
      eventType: asString(row.eventType) ?? "unknown",
      actionClass: asString(row.actionClass) ?? "unknown",
      provider: asString(row.provider),
      costUsd: asNumber(row.costUsd),
      tokensUsed: asNumber(row.tokensUsed),
      createdAt: asString(row.createdAt),
    }));
  return { total: rows.length, byActionClass, byEventType, totalCostUsd: hasCost ? costTotal : null, recent };
}

function summarizePrOutcomes(records: PrOutcomeRecord[]): PrOutcomesSummary {
  const byDecision: Record<PrOutcomeDecision, number> = { merged: 0, closed: 0 };
  const byReason: Record<string, number> = {};
  for (const record of records) {
    const decision = asString(record.decision);
    if (decision === "merged" || decision === "closed") byDecision[decision] += 1;
    const reason = asString(record.reason);
    if (reason) byReason[reason] = (byReason[reason] ?? 0) + 1;
  }
  // readPrOutcomes yields most-recently-updated LAST (#7222), so slice-tail + reverse is newest-first, matching the
  // ledgers feed. Projected to SAFE columns only.
  const recent = records
    .slice(-RECENT_EVENT_LIMIT)
    .reverse()
    .map((record) => ({
      repoFullName: asString(record.repoFullName),
      prNumber: asNumber(record.prNumber),
      decision: asString(record.decision) === "closed" ? ("closed" as const) : ("merged" as const),
      reason: asString(record.reason),
      closedAt: asString(record.closedAt),
    }));
  return { total: records.length, byDecision, byReason, recent };
}

export type AttemptLogApiDeps = {
  loadAttemptLogModule: () => Promise<AttemptLogModule>;
  loadEventLedgerModule: () => Promise<EventLedgerModule>;
  loadPrOutcomeModule: () => Promise<PrOutcomeModule>;
  fileExists: (path: string) => boolean;
};

const defaultDeps: AttemptLogApiDeps = {
  loadAttemptLogModule: () => import("../../packages/loopover-miner/lib/attempt-log.js") as Promise<AttemptLogModule>,
  loadEventLedgerModule: () =>
    import("../../packages/loopover-miner/lib/event-ledger.js") as Promise<EventLedgerModule>,
  loadPrOutcomeModule: () => import("../../packages/loopover-miner/lib/pr-outcome.js") as Promise<PrOutcomeModule>,
  fileExists: existsSync,
};

/** Request handler factored out of the Vite plugin shape so tests drive it directly (mirrors the sibling APIs). */
export async function handleAttemptLogRequest(
  method: string | undefined,
  url: string | undefined,
  deps: AttemptLogApiDeps = defaultDeps,
): Promise<{ status: number; body: string } | null> {
  if (url !== "/api/attempt-log" || (method !== undefined && method !== "GET")) return null;
  try {
    const summary = emptyAttemptLogSummary();

    const attemptLog = await deps.loadAttemptLogModule();
    if (deps.fileExists(attemptLog.resolveAttemptLogDbPath())) {
      summary.attempts = summarizeAttempts(attemptLog.readAttemptLogEvents());
    }
    // PR-outcomes live in the EVENT ledger (pr-outcome.js is a typed view over it), so they are gated on the event
    // ledger's own DB file and reduced through a reader built from that ledger's `readEvents` export (#7656).
    const eventLedger = await deps.loadEventLedgerModule();
    const prOutcome = await deps.loadPrOutcomeModule();
    if (deps.fileExists(eventLedger.resolveEventLedgerDbPath())) {
      const reader = { readEvents: (filter?: unknown) => eventLedger.readEvents(filter) };
      summary.prOutcomes = summarizePrOutcomes([...prOutcome.readPrOutcomes(reader).values()]);
    }
    return { status: 200, body: JSON.stringify({ summary }) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed to read the local attempt log";
    return { status: 500, body: JSON.stringify({ error: message }) };
  }
}

/** Vite dev/preview middleware serving the local read-only attempt-log endpoint. */
export function attemptLogApiPlugin(deps: AttemptLogApiDeps = defaultDeps): Plugin {
  const attach = (middlewares: {
    use: (
      fn: (
        req: { method?: string; url?: string },
        res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void },
        next: () => void,
      ) => void,
    ) => void;
  }) => {
    middlewares.use((req, res, next) => {
      void handleAttemptLogRequest(req.method, req.url, deps).then((handled) => {
        if (!handled) return next();
        res.statusCode = handled.status;
        res.setHeader("Content-Type", "application/json");
        res.end(handled.body);
      });
    });
  };
  return {
    name: "loopover-miner-ui:attempt-log-api",
    configureServer(server) {
      attach(server.middlewares);
    },
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
