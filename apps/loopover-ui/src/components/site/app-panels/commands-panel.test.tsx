import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the API layer so the component never touches the network.
const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/lib/api/request", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/api/origin", () => ({ getApiOrigin: () => "https://api.test" }));

const { useApiResource } = vi.hoisted(() => ({ useApiResource: vi.fn() }));
vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: (...args: unknown[]) => useApiResource(...args),
}));

import { CommandsPanel } from "@/components/site/app-panels/commands-panel";

const COMMAND = {
  id: "gate-override",
  command: "/loopover gate-override",
  audience: "Maintainers",
  boundary: "public" as const,
  description: "Override the gate verdict.",
  endpoint: "POST /v1/app/commands/preview",
};

/** Drive the panel to a valid repo/PR context so the preview effect fires. */
function enterContext() {
  fireEvent.change(screen.getByPlaceholderText("owner/repo"), {
    target: { value: "acme/widgets" },
  });
  fireEvent.change(screen.getByPlaceholderText("123"), { target: { value: "12" } });
}

function mockPreview(body: string) {
  apiFetch.mockResolvedValue({
    ok: true,
    data: { preview: { boundary: "public" as const, body } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useApiResource.mockReturnValue({
    status: "ready",
    data: { commands: [COMMAND] },
    reload: vi.fn(),
  });
});

describe("CommandsPanel bot-reply rendering (#7531)", () => {
  it("keeps underscore-heavy identifiers intact instead of italicizing a fragment", async () => {
    mockPreview("Use LOOPOVER_ENABLE_PAGERDUTY to opt in, and set repo_full_name accordingly.");
    const { container } = render(<CommandsPanel />);
    enterContext();

    // The whole line survives as one text node -- previously `_ENABLE_` and `_full_` were split out
    // and rendered as <em>, silently dropping the underscores from both identifiers.
    await waitFor(() => {
      expect(
        screen.getByText(
          "Use LOOPOVER_ENABLE_PAGERDUTY to opt in, and set repo_full_name accordingly.",
        ),
      ).toBeTruthy();
    });
    expect(container.querySelectorAll("em")).toHaveLength(0);
  });

  it("still renders genuine markdown italics as <em>", async () => {
    mockPreview("This is _emphasized_ text.");
    const { container } = render(<CommandsPanel />);
    enterContext();

    await waitFor(() => {
      const emphasis = container.querySelectorAll("em");
      expect(emphasis).toHaveLength(1);
      expect(emphasis[0]?.textContent).toBe("emphasized");
    });
  });

  it("leaves underscores inside a code span alone", async () => {
    mockPreview("Set `repo_full_name` in the payload.");
    const { container } = render(<CommandsPanel />);
    enterContext();

    await waitFor(() => {
      const code = container.querySelectorAll("code");
      expect(code).toHaveLength(1);
      expect(code[0]?.textContent).toBe("repo_full_name");
    });
    expect(container.querySelectorAll("em")).toHaveLength(0);
  });
});
