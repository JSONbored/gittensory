// Synthetic fixtures for the public miner-ui demo Worker (#5963). Values are deliberately fake —
// no real trust scores, reward amounts, operator credentials, or private scoring detail. Mutable
// module state lets pause / release / requeue feel interactive without a backend.

import type { AttemptActionInput, AttemptActionResult } from "./attempt";
import type { DiscoverActionInput, DiscoverActionResult } from "./discover";
import type { GovernorPauseState, GovernorPauseStateResult } from "./governor";
import type { LedgersResult, LedgersSummary } from "./ledgers";
import type { PortfolioQueueResult, PortfolioQueueSummary } from "./portfolio-queue";
import type {
  PortfolioQueueActionItem,
  PortfolioQueueActionResult,
  PortfolioQueueItemsResult,
} from "./portfolio-queue-actions";
import type { RunHistoryResult, RunStateRow } from "./run-history";

const DEMO_API_BASE = "https://api.github.com";
const DEMO_REPO_A = "demo-org/sample-widgets";
const DEMO_REPO_B = "demo-org/sample-gadgets";

const DEMO_RUN_ROWS: RunStateRow[] = [
  {
    apiBaseUrl: DEMO_API_BASE,
    repoFullName: DEMO_REPO_A,
    state: "discovering",
    updatedAt: "2026-07-16T12:00:00.000Z",
  },
  {
    apiBaseUrl: DEMO_API_BASE,
    repoFullName: DEMO_REPO_B,
    state: "idle",
    updatedAt: "2026-07-16T11:45:00.000Z",
  },
  {
    apiBaseUrl: "https://gitlab.example.test/api/v4",
    repoFullName: DEMO_REPO_A,
    state: "planning",
    updatedAt: "2026-07-16T11:30:00.000Z",
  },
];

const DEMO_LEDGERS: LedgersSummary = {
  claims: { total: 5, byStatus: { active: 2, released: 2, expired: 1 } },
  events: {
    total: 4,
    byType: { attempt_started: 2, attempt_succeeded: 1, attempt_deferred: 1 },
    recent: [
      {
        eventType: "attempt_succeeded",
        repoFullName: DEMO_REPO_A,
        createdAt: "2026-07-16T10:05:00.000Z",
      },
      {
        eventType: "attempt_started",
        repoFullName: DEMO_REPO_B,
        createdAt: "2026-07-16T10:00:00.000Z",
      },
      {
        eventType: "attempt_deferred",
        repoFullName: DEMO_REPO_A,
        createdAt: "2026-07-16T09:55:00.000Z",
      },
    ],
  },
  governor: {
    total: 3,
    byEventType: { rate_limit_deferred: 2, budget_deferred: 1 },
  },
};

function buildQueueSummary(items: PortfolioQueueActionItem[]): PortfolioQueueSummary {
  const queuedExtra = 2; // synthetic queued-only rows that aren't actionable
  const byStatus = { queued: queuedExtra, in_progress: 0, done: 0 };
  for (const item of items) {
    byStatus[item.status] += 1;
  }
  const repos = [DEMO_REPO_A, DEMO_REPO_B].map((repoFullName) => {
    const repoItems = items.filter((item) => item.repoFullName === repoFullName);
    const repoByStatus = {
      queued: repoFullName === DEMO_REPO_A ? 1 : 1,
      in_progress: repoItems.filter((i) => i.status === "in_progress").length,
      done: repoItems.filter((i) => i.status === "done").length,
    };
    return {
      repoFullName,
      byStatus: repoByStatus,
      total: repoByStatus.queued + repoByStatus.in_progress + repoByStatus.done,
    };
  });
  return {
    total: byStatus.queued + byStatus.in_progress + byStatus.done,
    byStatus,
    repos,
    oldestQueuedAgeMs: 3_600_000,
  };
}

let pauseState: GovernorPauseState = {
  paused: false,
  reason: null,
  pausedAt: null,
};

let actionItems: PortfolioQueueActionItem[] = [
  {
    apiBaseUrl: DEMO_API_BASE,
    repoFullName: DEMO_REPO_A,
    identifier: "issue:42",
    status: "in_progress",
  },
  {
    apiBaseUrl: DEMO_API_BASE,
    repoFullName: DEMO_REPO_B,
    identifier: "issue:7",
    status: "done",
  },
];

/** Reset mutable demo state — used by unit tests. */
export function resetDemoData(): void {
  pauseState = { paused: false, reason: null, pausedAt: null };
  actionItems = [
    {
      apiBaseUrl: DEMO_API_BASE,
      repoFullName: DEMO_REPO_A,
      identifier: "issue:42",
      status: "in_progress",
    },
    {
      apiBaseUrl: DEMO_API_BASE,
      repoFullName: DEMO_REPO_B,
      identifier: "issue:7",
      status: "done",
    },
  ];
}

export function demoFetchRunStates(): RunHistoryResult {
  return { ok: true, rows: DEMO_RUN_ROWS };
}

export function demoFetchLedgers(): LedgersResult {
  return { ok: true, summary: DEMO_LEDGERS };
}

export function demoFetchPortfolioQueue(): PortfolioQueueResult {
  return { ok: true, summary: buildQueueSummary(actionItems) };
}

export function demoFetchPortfolioQueueItems(): PortfolioQueueItemsResult {
  return { ok: true, items: [...actionItems] };
}

export function demoFetchGovernorPauseState(): GovernorPauseStateResult {
  return { ok: true, pauseState: { ...pauseState } };
}

export function demoPauseGovernor(reason?: string): GovernorPauseStateResult {
  pauseState = {
    paused: true,
    reason: reason?.trim() ? reason.trim() : "demo pause",
    pausedAt: "2026-07-16T12:30:00.000Z",
  };
  return { ok: true, pauseState: { ...pauseState } };
}

export function demoResumeGovernor(): GovernorPauseStateResult {
  pauseState = { paused: false, reason: null, pausedAt: null };
  return { ok: true, pauseState: { ...pauseState } };
}

export function demoReleasePortfolioQueueItem(
  item: Pick<PortfolioQueueActionItem, "repoFullName" | "identifier" | "apiBaseUrl">,
): PortfolioQueueActionResult {
  const index = actionItems.findIndex(
    (entry) =>
      entry.repoFullName === item.repoFullName &&
      entry.identifier === item.identifier &&
      entry.apiBaseUrl === item.apiBaseUrl &&
      entry.status === "in_progress",
  );
  if (index === -1) {
    return { ok: false, error: "demo queue: no matching in_progress item to release" };
  }
  actionItems = actionItems.filter((_, i) => i !== index);
  return {
    ok: true,
    entry: { repoFullName: item.repoFullName, identifier: item.identifier, status: "queued" },
  };
}

export function demoRequeuePortfolioQueueItem(
  item: Pick<PortfolioQueueActionItem, "repoFullName" | "identifier" | "apiBaseUrl">,
): PortfolioQueueActionResult {
  const index = actionItems.findIndex(
    (entry) =>
      entry.repoFullName === item.repoFullName &&
      entry.identifier === item.identifier &&
      entry.apiBaseUrl === item.apiBaseUrl &&
      entry.status === "done",
  );
  if (index === -1) {
    return { ok: false, error: "demo queue: no matching done item to requeue" };
  }
  const next = [...actionItems];
  next[index] = { ...next[index]!, status: "in_progress" };
  actionItems = next;
  return {
    ok: true,
    entry: { repoFullName: item.repoFullName, identifier: item.identifier, status: "queued" },
  };
}

export function demoRequestDiscover(_input: DiscoverActionInput): DiscoverActionResult {
  return {
    ok: true,
    exitCode: 0,
    result: {
      dryRun: true,
      targets: [DEMO_REPO_A],
      note: "Synthetic discover result for the public demo — no real forge calls were made.",
    },
  };
}

export function demoRequestAttempt(input: AttemptActionInput): AttemptActionResult {
  return {
    ok: true,
    exitCode: 0,
    result: {
      dryRun: true,
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      outcome: "demo_skipped",
      note: "Synthetic attempt result for the public demo — no worktree or agent was started.",
    },
  };
}

/** Yield a short canned assistant reply without contacting `/api/chat`. */
export async function* demoStreamChat(): AsyncGenerator<string> {
  const reply =
    "This is the public LoopOver miner-ui demo. Queue, run-history, and ledger panels show synthetic sample data only — no operator credentials or live miner state.";
  // Chunk like a real SSE stream so the typing indicator / StreamingText path still exercises.
  const mid = Math.ceil(reply.length / 2);
  yield reply.slice(0, mid);
  yield reply.slice(mid);
}
