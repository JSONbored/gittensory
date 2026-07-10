import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  emptyPortfolioQueueSummary,
  fetchPortfolioQueue,
  PORTFOLIO_QUEUE_API_PATH,
  summarizePortfolioQueueStatuses,
  type PortfolioQueueResult,
} from "./lib/portfolio-queue";
import { PortfolioPage, PortfolioQueueView } from "./routes/portfolio";
import { handlePortfolioQueueRequest, type PortfolioQueueApiDeps } from "../vite-portfolio-queue-api";

const fixtureSummary = {
  total: 4,
  counts: { queued: 2, in_progress: 1, done: 1 },
};

const rawQueueRows = [
  {
    repoFullName: "private-org/secret-repo",
    identifier: "issue:12",
    priority: 5,
    status: "queued",
    enqueuedAt: "2026-07-10T06:00:00.000Z",
  },
  {
    repoFullName: "private-org/secret-repo",
    identifier: "issue:13",
    priority: 3,
    status: "in_progress",
    enqueuedAt: "2026-07-10T06:05:00.000Z",
  },
  {
    repoFullName: "private-org/another-repo",
    identifier: "issue:7",
    priority: 8,
    status: "done",
    enqueuedAt: "2026-07-10T05:00:00.000Z",
  },
  {
    repoFullName: "private-org/another-repo",
    identifier: "issue:8",
    priority: 1,
    status: "queued",
    enqueuedAt: "2026-07-10T05:30:00.000Z",
  },
];

describe("summarizePortfolioQueueStatuses (#4306)", () => {
  it("counts queue statuses without retaining row identifiers", () => {
    expect(summarizePortfolioQueueStatuses(["queued", "in_progress", "done", "queued"])).toEqual(fixtureSummary);
  });

  it("summarizes an empty queue to zeros", () => {
    expect(emptyPortfolioQueueSummary()).toEqual({
      total: 0,
      counts: { queued: 0, in_progress: 0, done: 0 },
    });
  });
});

describe("PortfolioQueueView (#4306)", () => {
  it("renders one card per status with the aggregated counts", () => {
    render(<PortfolioQueueView result={{ ok: true, summary: fixtureSummary }} />);
    expect(screen.getByText("Queued").nextSibling?.textContent).toBe("2");
    expect(screen.getByText("In progress").nextSibling?.textContent).toBe("1");
    expect(screen.getByText("Done").nextSibling?.textContent).toBe("1");
  });

  it("renders the fresh-install empty state without erroring", () => {
    render(<PortfolioQueueView result={{ ok: true, summary: emptyPortfolioQueueSummary() }} />);
    expect(screen.getByText(/No queued work yet/i)).toBeTruthy();
  });

  it("renders an error message when the local API is unreachable", () => {
    render(<PortfolioQueueView result={{ ok: false, error: "connection refused" }} />);
    expect(screen.getByRole("alert").textContent).toContain("connection refused");
  });

  it("renders the loading state before the first result arrives", () => {
    render(<PortfolioQueueView result={null} />);
    expect(screen.getByText(/Loading local portfolio queue/i)).toBeTruthy();
  });
});

describe("PortfolioPage (#4306)", () => {
  it("loads the summary through the injected loader and renders the cards", async () => {
    const loadPortfolioQueue = async (): Promise<PortfolioQueueResult> => ({ ok: true, summary: fixtureSummary });
    render(<PortfolioPage loadPortfolioQueue={loadPortfolioQueue} />);
    expect(screen.getByRole("heading", { name: "Portfolio queue" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Queued").nextSibling?.textContent).toBe("2"));
  });
});

describe("fetchPortfolioQueue (#4306)", () => {
  const jsonResponse = (status: number, payload: unknown) =>
    ({ ok: status >= 200 && status < 300, status, json: async () => payload }) as unknown as Response;

  it("returns a typed summary from a well-formed payload, requesting the local API path", async () => {
    let requested: string | undefined;
    const result = await fetchPortfolioQueue(async (input) => {
      requested = String(input);
      return jsonResponse(200, { summary: fixtureSummary });
    });
    expect(requested).toBe(PORTFOLIO_QUEUE_API_PATH);
    expect(result).toEqual({ ok: true, summary: fixtureSummary });
  });

  it("surfaces non-2xx, malformed payloads, and thrown fetches as typed errors", async () => {
    expect(await fetchPortfolioQueue(async () => jsonResponse(500, {}))).toEqual({
      ok: false,
      error: "local portfolio-queue API responded 500",
    });
    expect(await fetchPortfolioQueue(async () => jsonResponse(200, { rows: rawQueueRows }))).toMatchObject({
      ok: false,
    });
    expect(
      await fetchPortfolioQueue(async () => jsonResponse(200, { summary: { total: 1, counts: { queued: "1" } } })),
    ).toMatchObject({ ok: false });
    expect(
      await fetchPortfolioQueue(async () => {
        throw new Error("connection refused");
      }),
    ).toEqual({ ok: false, error: "connection refused" });
  });
});

describe("handlePortfolioQueueRequest (#4306)", () => {
  const rows = rawQueueRows;
  function deps(overrides: Partial<PortfolioQueueApiDeps> = {}): PortfolioQueueApiDeps {
    return {
      loadPortfolioQueueModule: async () => ({
        resolvePortfolioQueueDbPath: () => "/home/miner/.config/gittensory-miner/portfolio-queue.sqlite3",
        listQueue: () => rows,
      }),
      fileExists: () => true,
      ...overrides,
    };
  }

  it("serves only aggregate counts and omits raw queue metadata", async () => {
    const handled = await handlePortfolioQueueRequest("GET", "/api/portfolio-queue", deps());
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ summary: fixtureSummary }) });
    expect(handled?.body).not.toContain("private-org/secret-repo");
    expect(handled?.body).not.toContain("issue:12");
    expect(handled?.body).not.toContain("priority");
  });

  it("serves an empty summary on a fresh install WITHOUT initializing the store", async () => {
    let listed = false;
    const handled = await handlePortfolioQueueRequest(
      "GET",
      "/api/portfolio-queue",
      deps({
        loadPortfolioQueueModule: async () => ({
          resolvePortfolioQueueDbPath: () => "/nowhere/portfolio-queue.sqlite3",
          listQueue: () => {
            listed = true;
            return rows;
          },
        }),
        fileExists: () => false,
      }),
    );
    expect(handled).toEqual({ status: 200, body: JSON.stringify({ summary: emptyPortfolioQueueSummary() }) });
    expect(listed).toBe(false);
  });

  it("falls through (null) for other paths and non-GET methods", async () => {
    expect(await handlePortfolioQueueRequest("GET", "/api/run-state", deps())).toBeNull();
    expect(await handlePortfolioQueueRequest("POST", "/api/portfolio-queue", deps())).toBeNull();
  });

  it("surfaces a store read failure as a 500 with a safe message", async () => {
    const handled = await handlePortfolioQueueRequest(
      "GET",
      "/api/portfolio-queue",
      deps({
        loadPortfolioQueueModule: async () => {
          throw new Error("sqlite locked");
        },
      }),
    );
    expect(handled).toEqual({ status: 500, body: JSON.stringify({ error: "sqlite locked" }) });
  });
});
