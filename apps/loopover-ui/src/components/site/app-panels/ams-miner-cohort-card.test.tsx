import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the API layer so the component never touches the network.
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

import { AmsMinerCohortCard } from "@/components/site/app-panels/ams-miner-cohort-card";

const REVIEWABILITY = [{ pr: "acme/widgets#1" }];

const POPULATED_COMPARISON = {
  present: true,
  windowDays: 90,
  totalSubmitterCount: 5,
  checkedSubmitterCount: 5,
  amsCohort: {
    submitterCount: 2,
    prVolume: 20,
    acceptanceRate: 0.8,
    avgReviewCycleCount: 1.5,
    avgTimeToMergeMs: 3_600_000,
  },
  humanCohort: {
    submitterCount: 3,
    prVolume: 9,
    acceptanceRate: 0.5,
    avgReviewCycleCount: 2.5,
    avgTimeToMergeMs: 172_800_000,
  },
};

describe("AmsMinerCohortCard", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("shows a loading state, then renders both cohorts on load", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: POPULATED_COMPARISON });
    render(<AmsMinerCohortCard reviewability={REVIEWABILITY} />);

    expect(screen.getByText(/Loading AMS contributor mix/i)).toBeTruthy();
    await waitFor(() => expect(screen.getByText("AMS miners")).toBeTruthy());
    expect(screen.getByText("Other contributors")).toBeTruthy();
    expect(screen.getByText(/Window: 90 days · checked 5 of/i)).toBeTruthy();
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/repos/acme/widgets/ams-miner-cohort"),
      expect.objectContaining({ label: "AMS miner cohort comparison" }),
    );
  });

  it("renders the AMS cohort's acceptance rate, review-cycle count, and time-to-merge", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: POPULATED_COMPARISON });
    render(<AmsMinerCohortCard reviewability={REVIEWABILITY} />);
    await waitFor(() => expect(screen.getByText("AMS miners")).toBeTruthy());
    expect(screen.getByText("80%")).toBeTruthy();
    expect(screen.getByText("1.5")).toBeTruthy();
    expect(screen.getByText("1.0h")).toBeTruthy();
  });

  it("renders days for a time-to-merge at or beyond 24 hours", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: POPULATED_COMPARISON });
    render(<AmsMinerCohortCard reviewability={REVIEWABILITY} />);
    await waitFor(() => expect(screen.getByText("Other contributors")).toBeTruthy());
    expect(screen.getByText("2.0d")).toBeTruthy();
  });

  it("renders an empty state (never an error) when the API reports present: false", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: {
        present: false,
        windowDays: 0,
        totalSubmitterCount: 0,
        checkedSubmitterCount: 0,
        amsCohort: {
          submitterCount: 0,
          prVolume: 0,
          acceptanceRate: null,
          avgReviewCycleCount: null,
          avgTimeToMergeMs: null,
        },
        humanCohort: {
          submitterCount: 0,
          prVolume: 0,
          acceptanceRate: null,
          avgReviewCycleCount: null,
          avgTimeToMergeMs: null,
        },
      },
    });
    render(<AmsMinerCohortCard reviewability={REVIEWABILITY} />);
    await waitFor(() => expect(screen.getByText(/No identifiable AMS activity yet/i)).toBeTruthy());
  });

  it("renders — for a null acceptanceRate/avgTimeToMergeMs rather than fabricating a number", async () => {
    apiFetch.mockResolvedValue({
      ok: true,
      data: {
        ...POPULATED_COMPARISON,
        amsCohort: {
          submitterCount: 1,
          prVolume: 1,
          acceptanceRate: null,
          avgReviewCycleCount: null,
          avgTimeToMergeMs: null,
        },
      },
    });
    render(<AmsMinerCohortCard reviewability={REVIEWABILITY} />);
    await waitFor(() => expect(screen.getByText("AMS miners")).toBeTruthy());
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders an error state with the failure message when the comparison fails to load", async () => {
    apiFetch.mockResolvedValue({ ok: false, message: "503 Service Unavailable" });
    render(<AmsMinerCohortCard reviewability={REVIEWABILITY} />);

    await waitFor(() =>
      expect(screen.getByText(/Couldn't load the AMS contributor mix/i)).toBeTruthy(),
    );
    expect(screen.getByText("503 Service Unavailable")).toBeTruthy();
  });

  it("falls back to a manual owner/repo entry when no repos are registered yet", () => {
    render(<AmsMinerCohortCard reviewability={[]} />);
    expect(screen.getByText(/No registered repositories detected yet/i)).toBeTruthy();
    expect(screen.getByText(/Enter an installed repository to compare cohorts\./i)).toBeTruthy();
  });

  it("shows the 'view unavailable' copy for a typed repo string that doesn't parse as owner\\/repo", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: POPULATED_COMPARISON });
    render(<AmsMinerCohortCard reviewability={REVIEWABILITY} />);
    await waitFor(() => expect(screen.getByText("AMS miners")).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText("owner/repo"), {
      target: { value: "not-a-valid-slug" },
    });
    expect(screen.getByText(/This view is unavailable for this repository\./i)).toBeTruthy();
  });
});
