import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

// #6825: PreviewResult's "Public comment preview" block had no copy affordance, unlike the conceptually
// identical surface in playground-panel.tsx.
const { success, error } = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success, error } }));

import {
  PreviewResult,
  type SettingsPreviewResponse,
} from "@/components/site/app-panels/maintainer-panel";

const INSTALL_PREVIEW = {
  status: "ready" as const,
  summary: "All checks pass.",
  readScope: [],
  computedContext: [],
  previewBehavior: [],
  permissions: {
    status: "ready" as const,
    required: [],
    missing: [],
    missingEvents: [],
    summary: "ok",
  },
  publicOutputs: [],
  privateOnlyContext: [],
  commandAuthorization: [],
  auditBehavior: [],
  sanitizerBoundaries: [],
  manualControls: [],
  checklist: [],
};

function preview(overrides: Partial<SettingsPreviewResponse> = {}): SettingsPreviewResponse {
  return {
    repoFullName: "acme/widgets",
    generatedAt: "2026-07-10T00:00:00.000Z",
    installation: null,
    sample: {
      authorLogin: "octocat",
      authorType: "User",
      authorAssociation: "NONE",
      minerStatus: "confirmed",
      title: "Add cursor pagination",
      labels: [],
      linkedIssues: [],
    },
    decision: {
      willComment: true,
      willLabel: true,
      willCheckRun: true,
      skipped: false,
      skipReason: null,
      actions: ["comment", "label", "check_run"],
      summary: "Would comment and label this PR.",
    },
    previewComment: "Thanks for the PR! A couple of notes...",
    appliedLabel: "gittensor:reviewed",
    checkRun: { willCreate: true, title: "LoopOver review", detailLevel: "full" },
    checkRunReadiness: null,
    installPreview: INSTALL_PREVIEW,
    warnings: [],
    summary: "Would comment and label this PR.",
    ...overrides,
  };
}

describe("PreviewResult public comment preview copy button (#6825)", () => {
  beforeEach(() => {
    success.mockReset();
    error.mockReset();
  });

  it("copies the preview comment and shows a success toast on a genuine clipboard success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    render(<PreviewResult preview={preview()} error={null} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: /copy comment preview/i }));

    await waitFor(() => expect(success).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith("Thanks for the PR! A couple of notes...");
    expect(error).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("REGRESSION: shows an error toast (not a false success) when the clipboard write fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    render(<PreviewResult preview={preview()} error={null} busy={false} />);
    fireEvent.click(screen.getByRole("button", { name: /copy comment preview/i }));

    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
    expect(success).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("does not render a copy button when there is no comment to copy", () => {
    render(<PreviewResult preview={preview({ previewComment: null })} error={null} busy={false} />);
    expect(screen.queryByRole("button", { name: /copy comment preview/i })).toBeNull();
    expect(screen.getByText(/No public comment would be posted for this scenario\./i)).toBeTruthy();
  });
});
