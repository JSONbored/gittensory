import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { GateOutcomeCard } from "@/components/site/app-panels/gate-outcome-card";
import {
  bandForGateOutcomes,
  summarizeGateOutcomes,
} from "@/components/site/app-panels/gate-outcome-card-model";

describe("summarizeGateOutcomes", () => {
  it("derives the total and per-bucket percentages when all outcomes are present", () => {
    expect(summarizeGateOutcomes({ merged: 6, closed: 3, held: 1, windowDays: 30 })).toEqual({
      merged: 6,
      closed: 3,
      held: 1,
      total: 10,
      mergedPct: 60,
      closedPct: 30,
      heldPct: 10,
    });
  });

  it("handles a zero-in-one-bucket breakdown", () => {
    expect(summarizeGateOutcomes({ merged: 5, closed: 5, held: 0, windowDays: 30 })).toMatchObject({
      total: 10,
      mergedPct: 50,
      closedPct: 50,
      heldPct: 0,
    });
  });

  it("yields 0% for every bucket on an all-zero breakdown", () => {
    expect(summarizeGateOutcomes({ merged: 0, closed: 0, held: 0, windowDays: 7 })).toEqual({
      merged: 0,
      closed: 0,
      held: 0,
      total: 0,
      mergedPct: 0,
      closedPct: 0,
      heldPct: 0,
    });
  });
});

describe("bandForGateOutcomes", () => {
  it("bands by held share: empty info, <=25% ready, <=50% warn, above blocked", () => {
    expect(bandForGateOutcomes({ merged: 0, closed: 0, held: 0, windowDays: 30 })).toBe("info");
    expect(bandForGateOutcomes({ merged: 8, closed: 0, held: 2, windowDays: 30 })).toBe("ready");
    expect(bandForGateOutcomes({ merged: 5, closed: 1, held: 4, windowDays: 30 })).toBe("warn");
    expect(bandForGateOutcomes({ merged: 2, closed: 1, held: 7, windowDays: 30 })).toBe("blocked");
  });
});

describe("GateOutcomeCard", () => {
  it("renders the three outcome tiles with counts and shares", () => {
    render(<GateOutcomeCard breakdown={{ merged: 6, closed: 3, held: 1, windowDays: 30 }} />);
    expect(screen.getByText("Gate-outcome breakdown")).toBeTruthy();
    expect(screen.getByText("Auto-merged")).toBeTruthy();
    expect(screen.getByText("6")).toBeTruthy();
    expect(screen.getByText("60% of outcomes")).toBeTruthy();
    expect(screen.getByText("30-day window")).toBeTruthy();
  });

  it("shows an empty state for an all-zero breakdown", () => {
    render(<GateOutcomeCard breakdown={{ merged: 0, closed: 0, held: 0, windowDays: 7 }} />);
    expect(screen.getByText("No gate outcomes yet")).toBeTruthy();
  });

  it("renders a graceful EmptyState when the breakdown field is absent", () => {
    render(<GateOutcomeCard breakdown={undefined} />);
    expect(screen.getByText("Gate outcomes not yet available")).toBeTruthy();
  });
});
