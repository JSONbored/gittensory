import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttemptLogResult, AttemptLogSummary } from "./lib/attempt-log";
import { AttemptLogView, AttemptsPage } from "./routes/attempts";

const emptySummary = (): AttemptLogSummary => ({
  attempts: { total: 0, byActionClass: {}, byEventType: {}, totalCostUsd: null, recent: [] },
  prOutcomes: { total: 0, byDecision: { merged: 0, closed: 0 }, byReason: {}, recent: [] },
});

const fixtureSummary: AttemptLogSummary = {
  attempts: {
    total: 2,
    byActionClass: { code_edit: 1, plan: 1 },
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
        createdAt: "2026-07-18T14:01:00.000Z",
      },
      {
        attemptId: "att-1",
        eventType: "attempt_started",
        actionClass: "plan",
        provider: null,
        costUsd: null,
        tokensUsed: null,
        createdAt: null,
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
        closedAt: "2026-07-18T13:40:00.000Z",
      },
      { repoFullName: null, prNumber: null, decision: "merged", reason: null, closedAt: null },
    ],
  },
};

function manyCounts(count: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`action_${index}`, count - index]));
}

describe("AttemptLogView (#7656)", () => {
  it("renders action/event counts, the total cost, the recent-attempts feed, and PR-outcome decisions", () => {
    render(<AttemptLogView result={{ ok: true, summary: fixtureSummary }} />);
    expect(screen.getByText("Attempts (2)")).toBeTruthy();
    expect(screen.getAllByText("$0.0500").length).toBeGreaterThan(0);
    // action classes appear in the "by action class" table and one also in the recent feed.
    expect(screen.getAllByText("code_edit").length).toBeGreaterThan(0);
    expect(screen.getAllByText("att-1").length).toBe(2);
    expect(screen.getByText("claude-code")).toBeTruthy();
    expect(screen.getByText("Merged", { selector: "dt" }).nextSibling?.textContent).toBe("1");
    expect(screen.getByText("Closed", { selector: "dt" }).nextSibling?.textContent).toBe("1");
    expect(screen.getAllByText("insufficient_test_coverage").length).toBeGreaterThan(0);
    expect(screen.getByText("#13")).toBeTruthy();
    // Null columns render as em-dashes (provider, cost, tokens, repo, PR).
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders the fresh-install empty state when both stores are empty", () => {
    render(<AttemptLogView result={{ ok: true, summary: emptySummary() }} />);
    expect(screen.getByText(/No attempts yet/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("renders an error message when the local API is unreachable", () => {
    render(<AttemptLogView result={{ ok: false, error: "connection refused" }} />);
    expect(screen.getByRole("alert").textContent).toContain("connection refused");
  });

  it("renders a content-shaped loading skeleton (role=status)", () => {
    render(<AttemptLogView result={null} />);
    expect(screen.getByRole("status", { name: /loading local attempt log/i })).toBeTruthy();
  });

  it("paginates a count table client-side above 20 rows", () => {
    const summary: AttemptLogSummary = {
      ...emptySummary(),
      attempts: { total: 45, byActionClass: manyCounts(45), byEventType: {}, totalCostUsd: null, recent: [] },
    };
    render(<AttemptLogView result={{ ok: true, summary }} />);
    expect(screen.getByRole("navigation", { name: /pagination/i })).toBeTruthy();
    expect(screen.getByText("action_0")).toBeTruthy();
    expect(screen.queryByText("action_20")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "2" }));
    expect(screen.getByText("action_20")).toBeTruthy();
    expect(screen.queryByText("action_0")).toBeNull();
    // Previous / Next also move the page.
    fireEvent.click(screen.getByRole("link", { name: /go to previous page/i }));
    expect(screen.getByText("action_0")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: /go to next page/i }));
    expect(screen.getByText("action_20")).toBeTruthy();
  });
});

describe("AttemptsPage (#7656)", () => {
  it("loads the summary through the injected loader and renders it", async () => {
    const loadAttemptLog = async (): Promise<AttemptLogResult> => ({ ok: true, summary: fixtureSummary });
    render(<AttemptsPage loadAttemptLog={loadAttemptLog} />);
    expect(screen.getByRole("heading", { name: "Attempts" })).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Attempts (2)")).toBeTruthy());
  });

  describe("live refresh (#7656)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("re-polls the summary on the shared cadence, without any user action", async () => {
      vi.useFakeTimers();
      const loadAttemptLog = vi.fn(async (): Promise<AttemptLogResult> => ({ ok: true, summary: fixtureSummary }));
      render(<AttemptsPage loadAttemptLog={loadAttemptLog} pollIntervalMs={1000} />);
      await vi.waitFor(() => expect(loadAttemptLog).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => expect(loadAttemptLog).toHaveBeenCalledTimes(2));
    });
  });
});
