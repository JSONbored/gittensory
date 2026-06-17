import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

import {
  buildSkippedPrAuditPath,
  formatSkipReason,
  pullRequestHref,
} from "@/components/site/audit-feed-model";
import { AuditFeed } from "@/components/site/audit-feed";

const SAMPLE: {
  generatedAt: string;
  limit: number;
  hasMore: boolean;
  filters: { repoFullName: null; reason: null; since: null };
  items: Array<{
    repoFullName: string;
    pullNumber: number;
    reason: string;
    timestamp: string;
    remediation: string;
  }>;
} = {
  generatedAt: "2026-05-28T00:00:05.000Z",
  limit: 50,
  hasMore: false,
  filters: { repoFullName: null, reason: null, since: null },
  items: [
    {
      repoFullName: "repo-owner/owned-repo",
      pullNumber: 6,
      reason: "surface_off",
      timestamp: "2026-05-28T00:00:04.000Z",
      remediation: "Enable a PR public surface in repository settings.",
    },
  ],
};

describe("audit feed helpers", () => {
  it("builds query paths for skipped PR audit filters", () => {
    expect(buildSkippedPrAuditPath({ limit: 25 })).toBe("/v1/app/skipped-pr-audit?limit=25");
    expect(
      buildSkippedPrAuditPath({
        limit: 50,
        repoFullName: "repo-owner/owned-repo",
        reason: "bot_author",
        since: "2026-05-28T00:00:00.000Z",
      }),
    ).toBe(
      "/v1/app/skipped-pr-audit?limit=50&repoFullName=repo-owner%2Fowned-repo&reason=bot_author&since=2026-05-28T00%3A00%3A00.000Z",
    );
  });

  it("formats skip reasons and pull request links", () => {
    expect(formatSkipReason("surface_off")).toBe("Surface off");
    expect(formatSkipReason("legacy_skip_reason")).toBe("legacy skip reason");
    expect(pullRequestHref("repo-owner/owned-repo", 6)).toBe(
      "https://github.com/repo-owner/owned-repo/pull/6",
    );
  });
});

describe("AuditFeed", () => {
  beforeEach(() => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ ok: true, data: SAMPLE });
  });

  it("renders populated audit rows from the skipped-pr-audit API", async () => {
    render(<AuditFeed />);
    expect(await screen.findByText("repo-owner/owned-repo")).toBeTruthy();
    expect(screen.getByText("Enable a PR public surface in repository settings.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /#6/i }).getAttribute("href")).toBe(
      "https://github.com/repo-owner/owned-repo/pull/6",
    );
    expect(apiFetch).toHaveBeenCalledWith(
      "https://api.test/v1/app/skipped-pr-audit?limit=50",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("shows an empty state when the audit export has no items", async () => {
    apiFetch.mockResolvedValue({ ok: true, data: { ...SAMPLE, items: [] } });
    render(<AuditFeed />);
    expect(await screen.findByText("No skipped PR events")).toBeTruthy();
  });

  it("shows an error state when the audit request fails", async () => {
    apiFetch.mockResolvedValue({ ok: false, message: "insufficient_role" });
    render(<AuditFeed />);
    expect(await screen.findByText("Couldn't load skip audit")).toBeTruthy();
    expect(screen.getByText("insufficient_role")).toBeTruthy();
  });

  it("applies repository filters to subsequent audit requests", async () => {
    render(<AuditFeed />);
    await screen.findByText("repo-owner/owned-repo");
    apiFetch.mockClear();
    apiFetch.mockResolvedValue({ ok: true, data: SAMPLE });

    fireEvent.change(screen.getByPlaceholderText("owner/repo"), {
      target: { value: "repo-owner/owned-repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: /apply filters/i }));

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringContaining("repoFullName=repo-owner%2Fowned-repo"),
        expect.any(Object),
      ),
    );
  });
});
