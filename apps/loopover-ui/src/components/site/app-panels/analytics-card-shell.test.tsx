import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AnalyticsCardShell } from "@/components/site/app-panels/analytics-card-shell";

describe("AnalyticsCardShell", () => {
  it("renders the title, description, and the ready slot content when state is ready", () => {
    render(
      <AnalyticsCardShell
        title="Queue health"
        description="pending / in-flight / stuck"
        state="ready"
      >
        <div>ready content</div>
      </AnalyticsCardShell>,
    );
    expect(screen.getByRole("heading", { name: "Queue health" })).toBeTruthy();
    expect(screen.getByText("pending / in-flight / stuck")).toBeTruthy();
    expect(screen.getByText("ready content")).toBeTruthy();
  });

  it("renders the empty state with its title and hint, and no ready content, when state is empty", () => {
    render(
      <AnalyticsCardShell
        title="Queue health"
        state="empty"
        emptyTitle="No snapshot yet"
        emptyHint="Runs once the queue reports."
      >
        <div>ready content</div>
      </AnalyticsCardShell>,
    );
    expect(screen.getByText("No snapshot yet")).toBeTruthy();
    expect(screen.getByText("Runs once the queue reports.")).toBeTruthy();
    expect(screen.queryByText("ready content")).toBeNull();
  });

  it("renders skeleton placeholders (and no ready content) when state is loading", () => {
    const { container } = render(
      <AnalyticsCardShell title="Queue health" state="loading">
        <div>ready content</div>
      </AnalyticsCardShell>,
    );
    expect(screen.queryByText("ready content")).toBeNull();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("omits the description paragraph when none is provided", () => {
    const { container } = render(<AnalyticsCardShell title="Queue health" state="ready" />);
    expect(screen.getByRole("heading", { name: "Queue health" })).toBeTruthy();
    expect(container.querySelectorAll("p").length).toBe(0);
  });

  it("renders the header action across every state, including empty", () => {
    render(
      <AnalyticsCardShell
        title="Queue health"
        state="empty"
        action={<span>12 paired</span>}
        emptyTitle="No snapshot yet"
      >
        <div>ready content</div>
      </AnalyticsCardShell>,
    );
    expect(screen.getByText("12 paired")).toBeTruthy();
    expect(screen.getByText("No snapshot yet")).toBeTruthy();
    expect(screen.queryByText("ready content")).toBeNull();
  });
});
