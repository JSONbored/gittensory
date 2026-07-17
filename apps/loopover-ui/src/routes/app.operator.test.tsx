import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// #6816: app.operator.tsx's StateBoundary had no loadingSkeleton, falling through to the generic spinner.
const { useApiResource } = vi.hoisted(() => ({ useApiResource: vi.fn() }));
vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: (...args: unknown[]) => useApiResource(...args),
}));

import { OperatorDashboard } from "@/routes/app.operator";

describe("OperatorDashboard loading skeleton (#6816)", () => {
  it("shows a content-shaped skeleton (not the generic spinner) while the dashboard loads", () => {
    useApiResource.mockReturnValue({
      status: "loading",
      data: null,
      error: null,
      loadedAt: null,
      reload: () => {},
    });

    const { container } = render(<OperatorDashboard />);
    // The custom skeleton replaces the generic LoadingState — neither its title nor its spinner shows.
    expect(screen.queryByText("Loading operator dashboard…")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    // The placeholder renders animate-pulse blocks approximating the dashboard's stat + section grid.
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(1);
  });

  it("does not show the skeleton once the dashboard has real data", () => {
    // OperatorDashboard also renders NotificationReadinessCard and DeadLetterQueuePanel, both of which call
    // this SAME hook for their own resources -- key the mock by path so their unrelated states (including
    // DeadLetterQueuePanel's own loadingSkeleton) don't leak into the dashboard's own animate-pulse count.
    useApiResource.mockImplementation((path: string) => {
      if (path === "/v1/app/operator-dashboard") {
        return {
          status: "ready",
          data: {
            metrics: [{ label: "Installs", value: "12", delta: "+2" }],
            noiseReduction: [],
            weeklyReport: [],
          },
          error: null,
          loadedAt: "2026-07-17T00:00:00.000Z",
          reload: () => {},
        };
      }
      return {
        status: "error",
        data: null,
        error: "unavailable in this test",
        errorKind: "unknown",
        loadedAt: null,
        reload: () => {},
      };
    });

    const { container } = render(<OperatorDashboard />);
    expect(screen.getByText("Usage & value")).toBeTruthy();
    expect(container.querySelectorAll(".animate-pulse").length).toBe(0);
  });
});
