import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// #6817: app.analytics.tsx's StateBoundary had no loadingSkeleton, falling through to the generic spinner
// -- the same gap #6816 fixed for app.operator.tsx.
const { useApiResource } = vi.hoisted(() => ({ useApiResource: vi.fn() }));
vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: (...args: unknown[]) => useApiResource(...args),
}));

import { ProductAnalytics } from "@/routes/app.analytics";

describe("ProductAnalytics loading skeleton (#6817)", () => {
  it("shows a content-shaped skeleton (not the generic spinner) while the dashboard loads", () => {
    useApiResource.mockReturnValue({
      status: "loading",
      data: null,
      error: null,
      loadedAt: null,
      reload: () => {},
    });

    const { container } = render(<ProductAnalytics />);
    // The custom skeleton replaces the generic LoadingState — neither its title nor its spinner shows.
    expect(screen.queryByText("Loading analytics…")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    // The placeholder renders animate-pulse blocks approximating the dashboard's header + stat + card grid.
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(1);
  });

  it("does not show the skeleton once the dashboard has real data", () => {
    useApiResource.mockReturnValue({
      status: "ready",
      data: { metrics: [{ label: "Active repos", value: "12", delta: "+2" }], noiseReduction: [] },
      error: null,
      loadedAt: "2026-07-17T00:00:00.000Z",
      reload: () => {},
    });

    const { container } = render(<ProductAnalytics />);
    expect(screen.getByText("Usage & value analytics")).toBeTruthy();
    expect(container.querySelectorAll(".animate-pulse").length).toBe(0);
  });
});
