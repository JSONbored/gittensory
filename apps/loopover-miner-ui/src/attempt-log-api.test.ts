import { describe, expect, it, vi } from "vitest";

import { ATTEMPT_LOG_API_PATH, fetchAttemptLog, type AttemptLogSummary } from "./lib/attempt-log";
import {
  attemptLogApiPlugin,
  emptyAttemptLogSummary,
  handleAttemptLogRequest,
  type AttemptLogApiDeps,
} from "../vite-attempt-log-api";

// Raw store rows carrying excluded raw columns (the attempt log's free-text `payload`/`mode`/`reason`, and a junk
// `payload` on an outcome record) the summary must NEVER republish. The API structurally omits these fields, so
// whatever they contain — including any secret — cannot surface; the sentinels below are deliberately
// NON-secret-shaped so the repo's own secret scanner never trips, while still proving the raw fields are dropped.
const rawAttemptRows = [
  {
    attemptId: "att-1",
    eventType: "attempt_started",
    actionClass: "plan",
    mode: "auto",
    reason: "LEAK_CANARY_REASON_A",
    provider: null,
    costUsd: null,
    tokensUsed: null,
    createdAt: "t1",
    payload: { detail: "LEAK_CANARY_ATTEMPT_A" },
  },
  {
    attemptId: "att-1",
    eventType: "attempt_succeeded",
    actionClass: "code_edit",
    mode: "auto",
    reason: "LEAK_CANARY_REASON_B",
    provider: "claude-code",
    costUsd: 0.05,
    tokensUsed: 1200,
    createdAt: "t2",
    payload: { detail: "LEAK_CANARY_ATTEMPT_B" },
  },
];

const rawOutcomeRecords = [
  {
    repoFullName: "acme/widgets",
    prNumber: 12,
    decision: "merged",
    reason: null,
    closedAt: "t1",
    payload: { detail: "LEAK_CANARY_PR_A" },
  },
  {
    repoFullName: "acme/widgets",
    prNumber: 13,
    decision: "closed",
    reason: "insufficient_test_coverage",
    closedAt: "t2",
    payload: { detail: "LEAK_CANARY_PR_B" },
  },
];

const fixtureSummary: AttemptLogSummary = {
  attempts: {
    total: 2,
    byActionClass: { plan: 1, code_edit: 1 },
    byEventType: { attempt_started: 1, attempt_succeeded: 1 },
    totalCostUsd: 0.05,
    recent: [
      {
        attemptId: "att-1",
        eventType: "attempt_succeeded",
        actionClass: "code_edit",
        provider: "claude-code",
        costUsd: 0.05,
        tokensUsed: 1200,
        createdAt: "t2",
      },
      {
        attemptId: "att-1",
        eventType: "attempt_started",
        actionClass: "plan",
        provider: null,
        costUsd: null,
        tokensUsed: null,
        createdAt: "t1",
      },
    ],
  },
  prOutcomes: {
    total: 2,
    byDecision: { merged: 1, closed: 1 },
    byReason: { insufficient_test_coverage: 1 },
    recent: [
      {
        repoFullName: "acme/widgets",
        prNumber: 13,
        decision: "closed",
        reason: "insufficient_test_coverage",
        closedAt: "t2",
      },
      { repoFullName: "acme/widgets", prNumber: 12, decision: "merged", reason: null, closedAt: "t1" },
    ],
  },
};

describe("emptyAttemptLogSummary (#7656)", () => {
  it("summarizes an empty attempt log + outcome store to zeros/null", () => {
    expect(emptyAttemptLogSummary()).toEqual({
      attempts: { total: 0, byActionClass: {}, byEventType: {}, totalCostUsd: null, recent: [] },
      prOutcomes: { total: 0, byDecision: { merged: 0, closed: 0 }, byReason: {}, recent: [] },
    });
  });
});

describe("handleAttemptLogRequest (#7656)", () => {
  function deps(overrides: Partial<AttemptLogApiDeps> = {}): AttemptLogApiDeps {
    return {
      loadAttemptLogModule: async () => ({
        resolveAttemptLogDbPath: () => "/home/miner/.config/loopover-miner/attempt-log.sqlite3",
        readAttemptLogEvents: () => rawAttemptRows,
      }),
      loadEventLedgerModule: async () => ({
        resolveEventLedgerDbPath: () => "/home/miner/.config/loopover-miner/event-ledger.sqlite3",
        readEvents: () => [],
      }),
      loadPrOutcomeModule: async () => ({
        readPrOutcomes: (reader) => {
          // Exercise the reader wiring the handler builds from the event ledger's readEvents export.
          reader.readEvents();
          return new Map(rawOutcomeRecords.map((record) => [`${record.repoFullName}:${record.prNumber}`, record]));
        },
      }),
      fileExists: () => true,
      ...overrides,
    };
  }

  it("aggregates the attempt log and PR outcomes to counts plus a safe recent feed", async () => {
    const handled = await handleAttemptLogRequest("GET", "/api/attempt-log", deps());
    expect(handled?.status).toBe(200);
    const body = JSON.parse(handled?.body ?? "{}") as { summary: AttemptLogSummary };
    expect(body.summary).toEqual(fixtureSummary);
  });

  it("INVARIANT (canary): never republishes the raw attempt payload/mode/reason or any raw outcome payload", async () => {
    const handled = await handleAttemptLogRequest("GET", "/api/attempt-log", deps());
    const body = handled?.body ?? "";
    for (const forbidden of [
      "LEAK_CANARY_ATTEMPT_A",
      "LEAK_CANARY_ATTEMPT_B",
      "LEAK_CANARY_REASON_A",
      "LEAK_CANARY_REASON_B",
      "LEAK_CANARY_PR_A",
      "LEAK_CANARY_PR_B",
      "payload",
      "mode",
      "detail",
    ]) {
      expect(body).not.toContain(forbidden);
    }
  });

  it("serves an empty summary on a fresh install WITHOUT initializing any store", async () => {
    let attemptsRead = false;
    let outcomesRead = false;
    const handled = await handleAttemptLogRequest(
      "GET",
      "/api/attempt-log",
      deps({
        fileExists: () => false,
        loadAttemptLogModule: async () => ({
          resolveAttemptLogDbPath: () => "/nowhere/attempt-log.sqlite3",
          readAttemptLogEvents: () => {
            attemptsRead = true;
            return rawAttemptRows;
          },
        }),
        loadPrOutcomeModule: async () => ({
          readPrOutcomes: () => {
            outcomesRead = true;
            return new Map();
          },
        }),
      }),
    );
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ summary: emptyAttemptLogSummary() }) });
    expect(attemptsRead).toBe(false);
    expect(outcomesRead).toBe(false);
  });

  it("falls through (null) for other paths and non-GET methods", async () => {
    expect(await handleAttemptLogRequest("GET", "/api/ledgers", deps())).toBeNull();
    expect(await handleAttemptLogRequest("POST", "/api/attempt-log", deps())).toBeNull();
  });

  it("surfaces a store read failure as a 500 with a safe message", async () => {
    const handled = await handleAttemptLogRequest(
      "GET",
      "/api/attempt-log",
      deps({
        loadAttemptLogModule: async () => {
          throw new Error("sqlite locked");
        },
      }),
    );
    expect(handled).toEqual({ status: 500, body: JSON.stringify({ error: "sqlite locked" }) });
  });

  it("surfaces a non-Error throw as a 500 with a safe fallback message", async () => {
    const handled = await handleAttemptLogRequest(
      "GET",
      "/api/attempt-log",
      deps({
        loadAttemptLogModule: async () => {
          throw "nope";
        },
      }),
    );
    expect(handled).toEqual({ status: 500, body: JSON.stringify({ error: "failed to read the local attempt log" }) });
  });
});

describe("attemptLogApiPlugin middleware (#7656)", () => {
  it("serves a matching request and passes every other request through to next()", async () => {
    const plugin = attemptLogApiPlugin({
      loadAttemptLogModule: async () => ({
        resolveAttemptLogDbPath: () => "/db/attempt-log.sqlite3",
        readAttemptLogEvents: () => rawAttemptRows,
      }),
      loadEventLedgerModule: async () => ({
        resolveEventLedgerDbPath: () => "/db/event-ledger.sqlite3",
        readEvents: () => [],
      }),
      loadPrOutcomeModule: async () => ({ readPrOutcomes: () => new Map() }),
      fileExists: () => true,
    });
    let middleware: ((req: unknown, res: unknown, next: () => void) => void) | undefined;
    const server = { middlewares: { use: (fn: typeof middleware) => (middleware = fn) } };
    (plugin.configureServer as (s: unknown) => void)(server);
    (plugin.configurePreviewServer as (s: unknown) => void)(server);
    expect(middleware).toBeTypeOf("function");

    const next = vi.fn();
    middleware!({ method: "GET", url: "/api/other" }, {}, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalledTimes(1));

    const res = { statusCode: 0, setHeader: vi.fn(), end: vi.fn() };
    await new Promise<void>((resolve) => {
      res.end = vi.fn(() => resolve());
      middleware!({ method: "GET", url: "/api/attempt-log" }, res, vi.fn());
    });
    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/json");
  });
});

describe("fetchAttemptLog (#7656)", () => {
  const jsonResponse = (status: number, payload: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as unknown as Response;

  it("returns a typed summary from a well-formed payload, requesting the local API path", async () => {
    let requested: string | undefined;
    const result = await fetchAttemptLog(async (input) => {
      requested = String(input);
      return jsonResponse(200, { summary: fixtureSummary });
    });
    expect(requested).toBe(ATTEMPT_LOG_API_PATH);
    expect(result).toEqual({ ok: true, summary: fixtureSummary });
  });

  it("surfaces non-2xx, malformed payloads, and thrown fetches as typed errors", async () => {
    expect(await fetchAttemptLog(async () => jsonResponse(500, {}))).toEqual({
      ok: false,
      error: "local attempt-log API responded 500",
    });
    expect(await fetchAttemptLog(async () => jsonResponse(200, { summary: { attempts: { total: 1 } } }))).toMatchObject(
      {
        ok: false,
      },
    );
    // A malformed recent entry (bad decision) is rejected too.
    expect(
      await fetchAttemptLog(async () =>
        jsonResponse(200, {
          summary: {
            ...emptyAttemptLogSummary(),
            prOutcomes: {
              total: 1,
              byDecision: { merged: 1, closed: 0 },
              byReason: {},
              recent: [{ repoFullName: "a/b", prNumber: 1, decision: "reopened", reason: null, closedAt: null }],
            },
          },
        }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await fetchAttemptLog(async () => {
        throw new Error("connection refused");
      }),
    ).toEqual({ ok: false, error: "connection refused" });
    expect(
      await fetchAttemptLog(async () => {
        throw "x";
      }),
    ).toEqual({ ok: false, error: "failed to reach the local attempt-log API" });
  });

  it("#5963: in demo mode, returns a canned summary without ever calling fetch", async () => {
    vi.stubEnv("VITE_DEMO_MODE", "1");
    let called = false;
    const result = await fetchAttemptLog(async () => {
      called = true;
      return jsonResponse(200, { summary: fixtureSummary });
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(true);
    vi.unstubAllEnvs();
  });
});
