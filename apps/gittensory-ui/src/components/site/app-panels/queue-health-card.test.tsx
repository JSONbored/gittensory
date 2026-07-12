import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { QueueHealthCard } from "@/components/site/app-panels/queue-health-card";

const POPULATED = {
  openPullRequests: 12,
  stalePullRequests: 3,
  draftPullRequests: 2,
  unlinkedPullRequests: 1,
  collisionClusters: 4,
  ageBuckets: { under7Days: 7, days7To30: 3, over30Days: 2 },
  bandCounts: { low: 5, medium: 2, high: 1, critical: 0 },
};

describe("QueueHealthCard", () => {
  it("renders the aggregate counts, age buckets, collisions, and non-empty burden bands when populated", () => {
    render(<QueueHealthCard queueHealth={POPULATED} />);
    expect(screen.getByText("Open PRs")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText(/4 collision cluster/)).toBeTruthy();
    expect(screen.getByText(/< 7d 7/)).toBeTruthy();
    expect(screen.getByText(/> 30d 2/)).toBeTruthy();
    // Bands with a count render; a zero band (critical) is omitted.
    expect(screen.getByText(/low 5/)).toBeTruthy();
    expect(screen.getByText(/high 1/)).toBeTruthy();
    expect(screen.queryByText(/critical/)).toBeNull();
  });

  it("shows the 'queue is clear' empty state when the aggregate has zero open PRs", () => {
    render(
      <QueueHealthCard
        queueHealth={{
          openPullRequests: 0,
          stalePullRequests: 0,
          draftPullRequests: 0,
          unlinkedPullRequests: 0,
          collisionClusters: 0,
          ageBuckets: { under7Days: 0, days7To30: 0, over30Days: 0 },
          bandCounts: { low: 0, medium: 0, high: 0, critical: 0 },
        }}
      />,
    );
    expect(screen.getByText("Queue is clear")).toBeTruthy();
    expect(screen.queryByText("Open PRs")).toBeNull();
  });

  it("shows the 'not yet available' empty state when the queueHealth field is absent", () => {
    render(<QueueHealthCard />);
    expect(screen.getByText("Not yet available")).toBeTruthy();
  });
});
