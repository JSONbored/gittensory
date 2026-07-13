import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  fetchQueueActionable,
  QUEUE_ACTIONABLE_API_PATH,
  QUEUE_RELEASE_API_PATH,
  QUEUE_REQUEUE_API_PATH,
  releaseQueueItem,
  requeueQueueItem,
  type QueueActionableResult,
  type QueueActionResult,
  type ReleasableItem,
  type RequeueableItem,
} from "./lib/queue-actions";
import { emptyPortfolioQueueSummary } from "./lib/portfolio-queue";
import { PortfolioPage, QueueActionsSection, queueItemKey } from "./routes/portfolio";
import {
  handleQueueActionsRequest,
  matchQueueActionsRoute,
  queueActionsApiPlugin,
  type QueueActionsApiDeps,
} from "../vite-queue-actions-api";

const releasable: ReleasableItem = {
  apiBaseUrl: "https://api.github.com",
  repoFullName: "acme/widgets",
  identifier: "issue-1",
  leasedAt: "2026-07-13T12:00:00.000Z",
};

const requeueable: RequeueableItem = {
  apiBaseUrl: "https://api.github.com",
  repoFullName: "acme/widgets",
  identifier: "issue-2",
  enqueuedAt: "2026-07-13T11:00:00.000Z",
};

describe("queueItemKey (#4857)", () => {
  it("joins apiBaseUrl/repoFullName/identifier into one stable string", () => {
    expect(queueItemKey(releasable)).toBe("https://api.github.com|acme/widgets|issue-1");
  });
});

describe("QueueActionsSection (#4857)", () => {
  it("renders the loading state before the first result arrives", () => {
    render(
      <QueueActionsSection
        result={null}
        pendingKeys={new Set()}
        actionError={null}
        onRelease={() => undefined}
        onRequeue={() => undefined}
      />,
    );
    expect(screen.getByText(/Loading actionable queue items/i)).toBeTruthy();
  });

  it("renders an error message when the local API is unreachable", () => {
    render(
      <QueueActionsSection
        result={{ ok: false, error: "connection refused" }}
        pendingKeys={new Set()}
        actionError={null}
        onRelease={() => undefined}
        onRequeue={() => undefined}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("connection refused");
  });

  it("renders an empty state when there is nothing to act on", () => {
    render(
      <QueueActionsSection
        result={{ ok: true, releasable: [], requeueable: [] }}
        pendingKeys={new Set()}
        actionError={null}
        onRelease={() => undefined}
        onRequeue={() => undefined}
      />,
    );
    expect(screen.getByText(/No in-progress or completed items to act on/i)).toBeTruthy();
  });

  it("renders a releasable row and calls onRelease with the item when clicked", () => {
    const onRelease = vi.fn();
    render(
      <QueueActionsSection
        result={{ ok: true, releasable: [releasable], requeueable: [] }}
        pendingKeys={new Set()}
        actionError={null}
        onRelease={onRelease}
        onRequeue={() => undefined}
      />,
    );
    expect(screen.getByText("issue-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(onRelease).toHaveBeenCalledWith(releasable);
  });

  it("shows an em dash for a releasable row with no leasedAt", () => {
    render(
      <QueueActionsSection
        result={{ ok: true, releasable: [{ ...releasable, leasedAt: null }], requeueable: [] }}
        pendingKeys={new Set()}
        actionError={null}
        onRelease={() => undefined}
        onRequeue={() => undefined}
      />,
    );
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("renders a requeueable row and calls onRequeue with the item when clicked", () => {
    const onRequeue = vi.fn();
    render(
      <QueueActionsSection
        result={{ ok: true, releasable: [], requeueable: [requeueable] }}
        pendingKeys={new Set()}
        actionError={null}
        onRelease={() => undefined}
        onRequeue={onRequeue}
      />,
    );
    expect(screen.getByText("issue-2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Requeue" }));
    expect(onRequeue).toHaveBeenCalledWith(requeueable);
  });

  it("disables only the pending row's button, not other rows'", () => {
    const other: ReleasableItem = { ...releasable, identifier: "issue-3" };
    render(
      <QueueActionsSection
        result={{ ok: true, releasable: [releasable, other], requeueable: [] }}
        pendingKeys={new Set([queueItemKey(releasable)])}
        actionError={null}
        onRelease={() => undefined}
        onRequeue={() => undefined}
      />,
    );
    const buttons = screen.getAllByRole("button", { name: "Release" }) as HTMLButtonElement[];
    expect(buttons[0]?.disabled).toBe(true);
    expect(buttons[1]?.disabled).toBe(false);
  });

  it("renders an action-error alert above the item lists", () => {
    render(
      <QueueActionsSection
        result={{ ok: true, releasable: [], requeueable: [] }}
        pendingKeys={new Set()}
        actionError="queue_entry_not_in_progress"
        onRelease={() => undefined}
        onRequeue={() => undefined}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("queue_entry_not_in_progress");
  });
});

describe("fetchQueueActionable / releaseQueueItem / requeueQueueItem (#4857)", () => {
  const jsonResponse = (status: number, payload: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as unknown as Response;

  it("fetchQueueActionable returns a typed snapshot from a well-formed payload, requesting the local API path", async () => {
    let requested: string | undefined;
    const result = await fetchQueueActionable(async (input) => {
      requested = String(input);
      return jsonResponse(200, { releasable: [releasable], requeueable: [requeueable] });
    });
    expect(requested).toBe(QUEUE_ACTIONABLE_API_PATH);
    expect(result).toEqual({ ok: true, releasable: [releasable], requeueable: [requeueable] });
  });

  it("fetchQueueActionable surfaces non-2xx, malformed payloads, and thrown fetches as typed errors", async () => {
    expect(await fetchQueueActionable(async () => jsonResponse(500, {}))).toEqual({
      ok: false,
      error: "local queue-actionable API responded 500",
    });
    expect(
      await fetchQueueActionable(async () =>
        jsonResponse(200, { releasable: [{ repoFullName: "x" }], requeueable: [] }),
      ),
    ).toMatchObject({ ok: false });
    expect(
      await fetchQueueActionable(async () => jsonResponse(200, { releasable: [], requeueable: [{ identifier: "x" }] })),
    ).toMatchObject({ ok: false });
    expect(
      await fetchQueueActionable(async () => jsonResponse(200, { releasable: [null], requeueable: [] })),
    ).toMatchObject({ ok: false });
    expect(
      await fetchQueueActionable(async () => jsonResponse(200, { releasable: [], requeueable: ["not-an-object"] })),
    ).toMatchObject({ ok: false });
    expect(
      await fetchQueueActionable(async () => {
        throw new Error("connection refused");
      }),
    ).toEqual({ ok: false, error: "connection refused" });
    expect(
      await fetchQueueActionable(async () => {
        throw "not an Error instance";
      }),
    ).toEqual({ ok: false, error: "failed to reach the local queue-actionable API" });
  });

  it("releaseQueueItem POSTs the target to the release path and returns the resulting entry", async () => {
    let requested: { input: string; init: RequestInit | undefined } | undefined;
    const entry = {
      apiBaseUrl: releasable.apiBaseUrl,
      repoFullName: releasable.repoFullName,
      identifier: releasable.identifier,
      status: "queued",
      enqueuedAt: "2026-07-13T12:05:00.000Z",
    };
    const result = await releaseQueueItem(releasable, async (input, init) => {
      requested = { input: String(input), init };
      return jsonResponse(200, { ok: true, entry });
    });
    expect(requested?.input).toBe(QUEUE_RELEASE_API_PATH);
    expect(requested?.init?.method).toBe("POST");
    expect(JSON.parse(String(requested?.init?.body))).toEqual({
      apiBaseUrl: releasable.apiBaseUrl,
      repoFullName: releasable.repoFullName,
      identifier: releasable.identifier,
    });
    expect(result).toEqual({ ok: true, entry });
  });

  it("requeueQueueItem POSTs the target to the requeue path and returns the resulting entry", async () => {
    let requested: { input: string } | undefined;
    const entry = {
      apiBaseUrl: requeueable.apiBaseUrl,
      repoFullName: requeueable.repoFullName,
      identifier: requeueable.identifier,
      status: "queued",
      enqueuedAt: requeueable.enqueuedAt,
    };
    const result = await requeueQueueItem(requeueable, async (input) => {
      requested = { input: String(input) };
      return jsonResponse(200, { ok: true, entry });
    });
    expect(requested?.input).toBe(QUEUE_REQUEUE_API_PATH);
    expect(result).toEqual({ ok: true, entry });
  });

  it("release/requeue surface a business-outcome failure (ok:false) from the response body", async () => {
    const result: QueueActionResult = await releaseQueueItem(releasable, async () =>
      jsonResponse(200, { ok: false, error: "queue_entry_not_in_progress" }),
    );
    expect(result).toEqual({ ok: false, error: "queue_entry_not_in_progress" });
  });

  it("release/requeue fall back to a status-derived message when the failure body has no error string", async () => {
    const result: QueueActionResult = await releaseQueueItem(releasable, async () => jsonResponse(400, { ok: false }));
    expect(result).toEqual({ ok: false, error: "local queue action API responded 400" });
  });

  it("release/requeue surface a thrown fetch as a typed error", async () => {
    const failing: QueueActionResult = { ok: false, error: "connection refused" };
    expect(
      await releaseQueueItem(releasable, async () => {
        throw new Error("connection refused");
      }),
    ).toEqual(failing);
    expect(
      await requeueQueueItem(requeueable, async () => {
        throw new Error("connection refused");
      }),
    ).toEqual(failing);
  });

  it("release/requeue surface a non-Error thrown value with a generic fallback message", async () => {
    expect(
      await releaseQueueItem(releasable, async () => {
        throw "not an Error instance";
      }),
    ).toEqual({ ok: false, error: "failed to reach the local queue action API" });
  });
});

describe("matchQueueActionsRoute (#4857)", () => {
  it("matches GET (or method-less) requests to /api/queue/actionable", () => {
    expect(matchQueueActionsRoute("GET", "/api/queue/actionable")).toBe("actionable-get");
    expect(matchQueueActionsRoute(undefined, "/api/queue/actionable")).toBe("actionable-get");
  });

  it("matches POST /api/queue/release and /api/queue/requeue", () => {
    expect(matchQueueActionsRoute("POST", "/api/queue/release")).toBe("release-post");
    expect(matchQueueActionsRoute("POST", "/api/queue/requeue")).toBe("requeue-post");
  });

  it("matches nothing for any other method/path combination", () => {
    expect(matchQueueActionsRoute("POST", "/api/queue/actionable")).toBeNull();
    expect(matchQueueActionsRoute("GET", "/api/queue/release")).toBeNull();
    expect(matchQueueActionsRoute("GET", "/api/portfolio-queue")).toBeNull();
  });
});

describe("handleQueueActionsRequest (#4857)", () => {
  const inProgressRow = {
    apiBaseUrl: "https://api.github.com",
    repoFullName: "acme/widgets",
    identifier: "issue-1",
    status: "in_progress",
    leasedAt: "2026-07-13T12:00:00.000Z",
  };
  const doneRow = {
    apiBaseUrl: "https://api.github.com",
    repoFullName: "acme/widgets",
    identifier: "issue-2",
    status: "done",
    enqueuedAt: "2026-07-13T11:00:00.000Z",
  };
  const queuedRow = {
    apiBaseUrl: "https://api.github.com",
    repoFullName: "acme/widgets",
    identifier: "issue-3",
    status: "queued",
    enqueuedAt: "2026-07-13T10:00:00.000Z",
  };

  function deps(overrides: Partial<QueueActionsApiDeps> = {}): QueueActionsApiDeps {
    return {
      loadPortfolioQueueModule: async () => ({
        resolvePortfolioQueueDbPath: () => "/home/miner/.config/gittensory-miner/portfolio-queue.sqlite3",
        initPortfolioQueueStore: () => ({
          listInProgress: () => [inProgressRow],
          listQueue: () => [doneRow, queuedRow],
          reclaimStuckItem: (repoFullName: string, identifier: string) =>
            repoFullName === inProgressRow.repoFullName && identifier === inProgressRow.identifier
              ? {
                  apiBaseUrl: inProgressRow.apiBaseUrl,
                  repoFullName,
                  identifier,
                  status: "queued",
                  enqueuedAt: "2026-07-13T12:05:00.000Z",
                }
              : null,
          requeueItem: (repoFullName: string, identifier: string) =>
            repoFullName === doneRow.repoFullName && identifier === doneRow.identifier
              ? {
                  apiBaseUrl: doneRow.apiBaseUrl,
                  repoFullName,
                  identifier,
                  status: "queued",
                  enqueuedAt: doneRow.enqueuedAt,
                }
              : null,
          close: () => undefined,
        }),
      }),
      fileExists: () => true,
      ...overrides,
    };
  }

  it("falls through (null) for a request that matches none of the three queue-actions routes", async () => {
    expect(await handleQueueActionsRequest("GET", "/api/portfolio-queue", "", deps())).toBeNull();
    expect(await handleQueueActionsRequest("POST", "/api/queue/actionable", "", deps())).toBeNull();
  });

  it("GET actionable serves releasable (in_progress) and requeueable (done) items, stripping priority and excluding queued", async () => {
    const handled = await handleQueueActionsRequest("GET", "/api/queue/actionable", "", deps());
    expect(handled).toEqual({
      status: 200,
      body: JSON.stringify({
        releasable: [
          {
            apiBaseUrl: inProgressRow.apiBaseUrl,
            repoFullName: inProgressRow.repoFullName,
            identifier: inProgressRow.identifier,
            leasedAt: inProgressRow.leasedAt,
          },
        ],
        requeueable: [
          {
            apiBaseUrl: doneRow.apiBaseUrl,
            repoFullName: doneRow.repoFullName,
            identifier: doneRow.identifier,
            enqueuedAt: doneRow.enqueuedAt,
          },
        ],
      }),
    });
  });

  it("GET actionable serves an empty snapshot on a fresh install WITHOUT opening the store", async () => {
    let opened = false;
    const handled = await handleQueueActionsRequest(
      "GET",
      "/api/queue/actionable",
      "",
      deps({
        fileExists: () => false,
        loadPortfolioQueueModule: async () => ({
          resolvePortfolioQueueDbPath: () => "/nowhere/portfolio-queue.sqlite3",
          initPortfolioQueueStore: () => {
            opened = true;
            throw new Error("should not be called");
          },
        }),
      }),
    );
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ releasable: [], requeueable: [] }) });
    expect(opened).toBe(false);
  });

  it("POST release with a matching in-progress target returns the entry with priority stripped", async () => {
    const handled = await handleQueueActionsRequest(
      "POST",
      "/api/queue/release",
      JSON.stringify({ repoFullName: inProgressRow.repoFullName, identifier: inProgressRow.identifier }),
      deps(),
    );
    expect(handled).toEqual({
      status: 200,
      body: JSON.stringify({
        ok: true,
        entry: {
          apiBaseUrl: inProgressRow.apiBaseUrl,
          repoFullName: inProgressRow.repoFullName,
          identifier: inProgressRow.identifier,
          status: "queued",
          enqueuedAt: "2026-07-13T12:05:00.000Z",
        },
      }),
    });
  });

  it("POST requeue with a matching done target returns the entry", async () => {
    const handled = await handleQueueActionsRequest(
      "POST",
      "/api/queue/requeue",
      JSON.stringify({ repoFullName: doneRow.repoFullName, identifier: doneRow.identifier }),
      deps(),
    );
    expect(handled).toEqual({
      status: 200,
      body: JSON.stringify({
        ok: true,
        entry: {
          apiBaseUrl: doneRow.apiBaseUrl,
          repoFullName: doneRow.repoFullName,
          identifier: doneRow.identifier,
          status: "queued",
          enqueuedAt: doneRow.enqueuedAt,
        },
      }),
    });
  });

  it("POST release/requeue on a non-matching target returns a typed business-outcome failure, not an error status", async () => {
    const release = await handleQueueActionsRequest(
      "POST",
      "/api/queue/release",
      JSON.stringify({ repoFullName: "nowhere/nothing", identifier: "issue-9" }),
      deps(),
    );
    expect(release).toEqual({ status: 200, body: JSON.stringify({ ok: false, error: "queue_entry_not_in_progress" }) });
    const requeue = await handleQueueActionsRequest(
      "POST",
      "/api/queue/requeue",
      JSON.stringify({ repoFullName: "nowhere/nothing", identifier: "issue-9" }),
      deps(),
    );
    expect(requeue).toEqual({ status: 200, body: JSON.stringify({ ok: false, error: "queue_entry_not_requeuable" }) });
  });

  it("POST release/requeue on a fresh install (no store yet) returns the not-actionable outcome WITHOUT opening the store", async () => {
    let opened = false;
    const freshDeps = deps({
      fileExists: () => false,
      loadPortfolioQueueModule: async () => ({
        resolvePortfolioQueueDbPath: () => "/nowhere/portfolio-queue.sqlite3",
        initPortfolioQueueStore: () => {
          opened = true;
          throw new Error("should not be called");
        },
      }),
    });
    const release = await handleQueueActionsRequest(
      "POST",
      "/api/queue/release",
      JSON.stringify({ repoFullName: "acme/widgets", identifier: "issue-1" }),
      freshDeps,
    );
    expect(release).toEqual({ status: 200, body: JSON.stringify({ ok: false, error: "queue_entry_not_in_progress" }) });
    const requeue = await handleQueueActionsRequest(
      "POST",
      "/api/queue/requeue",
      JSON.stringify({ repoFullName: "acme/widgets", identifier: "issue-1" }),
      freshDeps,
    );
    expect(requeue).toEqual({ status: 200, body: JSON.stringify({ ok: false, error: "queue_entry_not_requeuable" }) });
    expect(opened).toBe(false);
  });

  it("threads an explicit apiBaseUrl from the request body through to the store call", async () => {
    let receivedApiBaseUrl: string | undefined;
    const handled = await handleQueueActionsRequest(
      "POST",
      "/api/queue/release",
      JSON.stringify({
        repoFullName: inProgressRow.repoFullName,
        identifier: inProgressRow.identifier,
        apiBaseUrl: "https://ghe.example.com/api/v3",
      }),
      deps({
        loadPortfolioQueueModule: async () => ({
          resolvePortfolioQueueDbPath: () => "/home/miner/.config/gittensory-miner/portfolio-queue.sqlite3",
          initPortfolioQueueStore: () => ({
            listInProgress: () => [inProgressRow],
            listQueue: () => [doneRow, queuedRow],
            reclaimStuckItem: (repoFullName: string, identifier: string, apiBaseUrl?: string) => {
              receivedApiBaseUrl = apiBaseUrl;
              return {
                apiBaseUrl: apiBaseUrl ?? inProgressRow.apiBaseUrl,
                repoFullName,
                identifier,
                status: "queued",
                enqueuedAt: "2026-07-13T12:05:00.000Z",
              };
            },
            requeueItem: () => null,
            close: () => undefined,
          }),
        }),
      }),
    );
    expect(receivedApiBaseUrl).toBe("https://ghe.example.com/api/v3");
    expect(handled?.status).toBe(200);
  });

  it("POST release/requeue rejects an empty, malformed, or field-missing body with 400", async () => {
    const empty = await handleQueueActionsRequest("POST", "/api/queue/release", "", deps());
    expect(empty).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_request_body" }) });
    const malformed = await handleQueueActionsRequest("POST", "/api/queue/release", "{not json", deps());
    expect(malformed).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_request_body" }) });
    const missingIdentifier = await handleQueueActionsRequest(
      "POST",
      "/api/queue/requeue",
      JSON.stringify({ repoFullName: "acme/widgets" }),
      deps(),
    );
    expect(missingIdentifier).toEqual({ status: 400, body: JSON.stringify({ error: "invalid_request_body" }) });
  });

  it("surfaces a store failure as a 500 with a safe message, for both read and write routes", async () => {
    const brokenDeps = deps({
      loadPortfolioQueueModule: async () => {
        throw new Error("sqlite locked");
      },
    });
    expect(await handleQueueActionsRequest("GET", "/api/queue/actionable", "", brokenDeps)).toEqual({
      status: 500,
      body: JSON.stringify({ error: "sqlite locked" }),
    });
    expect(
      await handleQueueActionsRequest(
        "POST",
        "/api/queue/release",
        JSON.stringify({ repoFullName: "a/b", identifier: "1" }),
        brokenDeps,
      ),
    ).toEqual({ status: 500, body: JSON.stringify({ error: "sqlite locked" }) });
  });

  it("surfaces a non-Error thrown value with a generic fallback message", async () => {
    const brokenDeps = deps({
      loadPortfolioQueueModule: async () => {
        throw "not an Error instance";
      },
    });
    expect(await handleQueueActionsRequest("GET", "/api/queue/actionable", "", brokenDeps)).toEqual({
      status: 500,
      body: JSON.stringify({ error: "failed to update the local portfolio queue" }),
    });
  });
});

type FakeReq = { method?: string; url?: string } & NodeJS.ReadableStream;

function fakeRequest(method: string | undefined, url: string | undefined, body = ""): FakeReq {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const req = {
    method,
    url,
    on(event: string, cb: (...args: unknown[]) => void) {
      (listeners[event] ??= []).push(cb);
      return req;
    },
  };
  queueMicrotask(() => {
    if (body) for (const cb of listeners.data ?? []) cb(Buffer.from(body));
    for (const cb of listeners.end ?? []) cb();
  });
  return req as unknown as FakeReq;
}

type CapturedRequestHandler = (
  req: FakeReq,
  res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (body: string) => void },
  next: () => void,
) => void;

function captureMiddleware(deps?: Partial<QueueActionsApiDeps>): CapturedRequestHandler {
  let captured: CapturedRequestHandler | undefined;
  const plugin = queueActionsApiPlugin(
    deps
      ? {
          loadPortfolioQueueModule: async () => ({
            resolvePortfolioQueueDbPath: () => "/home/miner/.config/gittensory-miner/portfolio-queue.sqlite3",
            initPortfolioQueueStore: () => ({
              listInProgress: () => [],
              listQueue: () => [],
              reclaimStuckItem: () => null,
              requeueItem: () => null,
              close: () => undefined,
            }),
          }),
          fileExists: () => true,
          ...deps,
        }
      : undefined,
  );
  const server = { middlewares: { use: (fn: CapturedRequestHandler) => (captured = fn) } };
  // @ts-expect-error -- the test double only implements the subset of Vite's ViteDevServer this plugin reads.
  plugin.configureServer(server);
  if (!captured) throw new Error("queueActionsApiPlugin did not register a middleware");
  return captured;
}

function fakeResponse() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
  let ended: string | undefined;
  return {
    res: {
      get statusCode() {
        return statusCode;
      },
      set statusCode(value: number) {
        statusCode = value;
      },
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
      end: (body: string) => {
        ended = body;
      },
    },
    headers,
    getEnded: () => ended,
    getStatus: () => statusCode,
  };
}

describe("queueActionsApiPlugin (#4857)", () => {
  it("falls through to next() for a request that matches none of the three queue-actions routes, never reading its body", async () => {
    const middleware = captureMiddleware();
    const { res } = fakeResponse();
    let calledNext = false;
    middleware(fakeRequest("GET", "/api/portfolio-queue"), res, () => {
      calledNext = true;
    });
    expect(calledNext).toBe(true);
  });

  it("serves GET /api/queue/actionable from the real (injected) store", async () => {
    const middleware = captureMiddleware({
      loadPortfolioQueueModule: async () => ({
        resolvePortfolioQueueDbPath: () => "/home/miner/.config/gittensory-miner/portfolio-queue.sqlite3",
        initPortfolioQueueStore: () => ({
          listInProgress: () => [
            {
              apiBaseUrl: "https://api.github.com",
              repoFullName: "acme/widgets",
              identifier: "issue-1",
              status: "in_progress",
              leasedAt: null,
            },
          ],
          listQueue: () => [],
          reclaimStuckItem: () => null,
          requeueItem: () => null,
          close: () => undefined,
        }),
      }),
    });
    const { res, getEnded, getStatus } = fakeResponse();
    middleware(fakeRequest("GET", "/api/queue/actionable"), res, () => undefined);
    await vi.waitFor(() => expect(getEnded()).toBeDefined());
    expect(getStatus()).toBe(200);
    expect(JSON.parse(getEnded() ?? "{}")).toEqual({
      releasable: [
        { apiBaseUrl: "https://api.github.com", repoFullName: "acme/widgets", identifier: "issue-1", leasedAt: null },
      ],
      requeueable: [],
    });
  });

  it("reads a POST body and releases via the real (injected) store", async () => {
    const middleware = captureMiddleware({
      loadPortfolioQueueModule: async () => ({
        resolvePortfolioQueueDbPath: () => "/home/miner/.config/gittensory-miner/portfolio-queue.sqlite3",
        initPortfolioQueueStore: () => ({
          listInProgress: () => [],
          listQueue: () => [],
          reclaimStuckItem: (repoFullName: string, identifier: string) => ({
            apiBaseUrl: "https://api.github.com",
            repoFullName,
            identifier,
            status: "queued",
            enqueuedAt: "2026-07-13T12:05:00.000Z",
          }),
          requeueItem: () => null,
          close: () => undefined,
        }),
      }),
    });
    const { res, getEnded, getStatus } = fakeResponse();
    middleware(
      fakeRequest(
        "POST",
        "/api/queue/release",
        JSON.stringify({ repoFullName: "acme/widgets", identifier: "issue-1" }),
      ),
      res,
      () => undefined,
    );
    await vi.waitFor(() => expect(getEnded()).toBeDefined());
    expect(getStatus()).toBe(200);
    expect(JSON.parse(getEnded() ?? "{}")).toEqual({
      ok: true,
      entry: {
        apiBaseUrl: "https://api.github.com",
        repoFullName: "acme/widgets",
        identifier: "issue-1",
        status: "queued",
        enqueuedAt: "2026-07-13T12:05:00.000Z",
      },
    });
  });

  it("also attaches via configurePreviewServer for `vite preview`", () => {
    let captured: CapturedRequestHandler | undefined;
    const plugin = queueActionsApiPlugin();
    const server = { middlewares: { use: (fn: CapturedRequestHandler) => (captured = fn) } };
    // @ts-expect-error -- same partial test double as configureServer above.
    plugin.configurePreviewServer(server);
    expect(captured).toBeTypeOf("function");
  });
});

describe("PortfolioPage queue-actions wiring (#4857)", () => {
  const portfolioResult = { ok: true as const, summary: emptyPortfolioQueueSummary() };

  it("loads the actionable snapshot on mount and re-fetches it after a successful action", async () => {
    let actionableCalls = 0;
    const loadQueueActionable = vi.fn(async (): Promise<QueueActionableResult> => {
      actionableCalls += 1;
      return actionableCalls === 1
        ? { ok: true, releasable: [releasable], requeueable: [] }
        : { ok: true, releasable: [], requeueable: [] };
    });
    const releaseAction = vi.fn(async (): Promise<QueueActionResult> => ({
      ok: true,
      entry: {
        apiBaseUrl: releasable.apiBaseUrl,
        repoFullName: releasable.repoFullName,
        identifier: releasable.identifier,
        status: "queued",
        enqueuedAt: "2026-07-13T12:05:00.000Z",
      },
    }));

    render(
      <PortfolioPage
        loadPortfolioQueue={async () => portfolioResult}
        loadQueueActionable={loadQueueActionable}
        releaseAction={releaseAction}
        requeueAction={async () => ({
          ok: true,
          entry: { apiBaseUrl: "", repoFullName: "", identifier: "", status: "", enqueuedAt: "" },
        })}
        pollIntervalMs={60_000}
      />,
    );

    await screen.findByText("issue-1");
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(releaseAction).toHaveBeenCalledWith(releasable);
    await screen.findByText(/No in-progress or completed items to act on/i);
    expect(loadQueueActionable).toHaveBeenCalledTimes(2);
  });

  it("shows an action-error alert and does NOT re-fetch when an action reports a business-outcome failure", async () => {
    const loadQueueActionable = vi.fn(async (): Promise<QueueActionableResult> => ({
      ok: true,
      releasable: [releasable],
      requeueable: [],
    }));
    const releaseAction = vi.fn(async (): Promise<QueueActionResult> => ({
      ok: false,
      error: "queue_entry_not_in_progress",
    }));

    render(
      <PortfolioPage
        loadPortfolioQueue={async () => portfolioResult}
        loadQueueActionable={loadQueueActionable}
        releaseAction={releaseAction}
        requeueAction={async () => ({
          ok: true,
          entry: { apiBaseUrl: "", repoFullName: "", identifier: "", status: "", enqueuedAt: "" },
        })}
        pollIntervalMs={60_000}
      />,
    );

    await screen.findByText("issue-1");
    fireEvent.click(screen.getByRole("button", { name: "Release" }));
    await screen.findByText(/queue_entry_not_in_progress/);
    expect(loadQueueActionable).toHaveBeenCalledTimes(1);
  });

  it("wires the Requeue button to requeueAction, distinct from the Release button", async () => {
    const loadQueueActionable = vi.fn(async (): Promise<QueueActionableResult> => ({
      ok: true,
      releasable: [],
      requeueable: [requeueable],
    }));
    const requeueAction = vi.fn(async (): Promise<QueueActionResult> => ({
      ok: true,
      entry: {
        apiBaseUrl: requeueable.apiBaseUrl,
        repoFullName: requeueable.repoFullName,
        identifier: requeueable.identifier,
        status: "queued",
        enqueuedAt: requeueable.enqueuedAt,
      },
    }));

    render(
      <PortfolioPage
        loadPortfolioQueue={async () => portfolioResult}
        loadQueueActionable={loadQueueActionable}
        releaseAction={async () => ({
          ok: true,
          entry: { apiBaseUrl: "", repoFullName: "", identifier: "", status: "", enqueuedAt: "" },
        })}
        requeueAction={requeueAction}
        pollIntervalMs={60_000}
      />,
    );

    await screen.findByText("issue-2");
    fireEvent.click(screen.getByRole("button", { name: "Requeue" }));
    expect(requeueAction).toHaveBeenCalledWith(requeueable);
    await vi.waitFor(() => expect(loadQueueActionable).toHaveBeenCalledTimes(2));
  });
});
