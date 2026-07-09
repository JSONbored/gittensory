import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FindingsBreakdownCard } from "@/components/site/app-panels/findings-breakdown-card";
import {
  categoryTotal,
  totalFindingsBreakdown,
} from "@/components/site/app-panels/findings-breakdown-card-model";

describe("findings-breakdown model", () => {
  it("sums a category row and folds aggregate totals", () => {
    expect(categoryTotal({ category: "security", high: 2, medium: 1, low: 0 })).toBe(3);
    expect(
      totalFindingsBreakdown({
        windowDays: 30,
        categories: [
          { category: "security", high: 2, medium: 1, low: 0 },
          { category: "style", high: 0, medium: 1, low: 4 },
        ],
      }),
    ).toEqual({ high: 2, medium: 2, low: 4, total: 8 });
  });

  it("folds an empty report to all zeros", () => {
    expect(totalFindingsBreakdown({ windowDays: 30, categories: [] })).toEqual({
      high: 0,
      medium: 0,
      low: 0,
      total: 0,
    });
  });
});

describe("FindingsBreakdownCard", () => {
  it("renders aggregate tiles and a row per category for a multi-category report", () => {
    render(
      <FindingsBreakdownCard
        report={{
          windowDays: 30,
          categories: [
            { category: "security", high: 2, medium: 1, low: 0 },
            { category: "style", high: 0, medium: 1, low: 4 },
          ],
        }}
      />,
    );
    expect(screen.getByText("Findings by category")).toBeTruthy();
    expect(screen.getByText("30-day window")).toBeTruthy();
    expect(screen.getByText("security")).toBeTruthy();
    expect(screen.getByText("style")).toBeTruthy();
    expect(screen.getByText("2 high")).toBeTruthy();
  });

  it("renders a single-category report", () => {
    render(
      <FindingsBreakdownCard
        report={{
          windowDays: 7,
          categories: [{ category: "security", high: 1, medium: 0, low: 0 }],
        }}
      />,
    );
    expect(screen.getByText("security")).toBeTruthy();
    expect(screen.getByText("7-day window")).toBeTruthy();
  });

  it("renders an EmptyState when there are no findings in the window", () => {
    render(<FindingsBreakdownCard report={{ windowDays: 30, categories: [] }} />);
    expect(screen.getByText("No findings in window")).toBeTruthy();
  });
});
