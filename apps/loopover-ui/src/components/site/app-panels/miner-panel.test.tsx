import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Stub the data hook + session so the panel renders without touching the network, and neuter the
// router Link / MCP badge that the miner dashboard pulls in.
const { useApiResource, useSession } = vi.hoisted(() => ({
  useApiResource: vi.fn(),
  useSession: vi.fn(),
}));
vi.mock("@/lib/api/use-api-resource", () => ({
  useApiResource: (...args: unknown[]) => useApiResource(...args),
}));
vi.mock("@/lib/api/session", () => ({ useSession: () => useSession() }));
vi.mock("@/components/site/mcp-version-badge", () => ({
  McpVersionBadge: () => <span>mcp</span>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children: React.ReactNode; to?: string }) => (
    <a href={props.to ?? "#"}>{children}</a>
  ),
}));

import { MinerPanel } from "@/components/site/app-panels/miner-panel";

describe("MinerPanel loading skeleton (#793)", () => {
  it("shows a content-shaped skeleton (not the generic spinner) while the decision pack loads", () => {
    useSession.mockReturnValue({
      session: { login: "miner", roles: ["miner"] },
      hydrated: true,
    });
    useApiResource.mockReturnValue({
      status: "loading",
      data: null,
      error: null,
      loadedAt: null,
      reload: () => {},
    });

    const { container } = render(<MinerPanel />);
    // The custom skeleton replaces the generic LoadingState — neither its title nor its spinner shows.
    // (A distinct always-present sr-only status live-region in the action bar rules out a role query.)
    expect(screen.queryByText("Loading miner signals…")).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
    // The placeholder renders animate-pulse blocks approximating the dashboard's metric + card grid.
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(1);
  });
});
