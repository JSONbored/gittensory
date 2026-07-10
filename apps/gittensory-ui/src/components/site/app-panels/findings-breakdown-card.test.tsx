import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FindingsBreakdownCard } from "@/components/site/app-panels/findings-breakdown-card";

describe("FindingsBreakdownCard", () => {
  it("renders a row per category with totals, severity counts, and the window label when populated", () => {
    render(
      <FindingsBreakdownCard
        findings={{
          windowDays: 30,
          categories: [
            { category: "security", total: 5, bySeverity: { blocker: 2, warning: 3 } },
            { category: "style", total: 4, bySeverity: { advisory: 1, nit: 3 } },
          ],
        }}
      />,
    );
    expect(screen.getByText("security")).toBeTruthy();
    expect(screen.getByText("style")).toBeTruthy();
    expect(screen.getByText(/blocker 2/)).toBeTruthy();
    expect(screen.getByText(/warning 3/)).toBeTruthy();
    expect(screen.getByText(/nit 3/)).toBeTruthy();
    expect(screen.getByText("30d window")).toBeTruthy();
  });

  it("renders a single-category breakdown", () => {
    render(
      <FindingsBreakdownCard
        findings={{
          windowDays: 7,
          categories: [{ category: "correctness", total: 1, bySeverity: { blocker: 1 } }],
        }}
      />,
    );
    expect(screen.getByText("correctness")).toBeTruthy();
    expect(screen.getByText(/blocker 1/)).toBeTruthy();
    // A severity with zero count is omitted from the row.
    expect(screen.queryByText(/nit/)).toBeNull();
  });

  it("shows the 'no findings in window' empty state when the breakdown is present but has no categories", () => {
    render(<FindingsBreakdownCard findings={{ windowDays: 14, categories: [] }} />);
    expect(screen.getByText("No findings in window")).toBeTruthy();
    expect(screen.queryByText("30d window")).toBeNull();
  });

  it("shows the 'not yet available' empty state when the findings field is absent", () => {
    render(<FindingsBreakdownCard />);
    expect(screen.getByText("Not yet available")).toBeTruthy();
    expect(screen.queryByText("security")).toBeNull();
  });
});
