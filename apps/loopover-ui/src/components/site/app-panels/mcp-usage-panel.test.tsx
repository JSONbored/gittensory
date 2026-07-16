import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Stub the data hook and the window store so the panel never touches the network or real localStorage.
const { useApiResource, useLocalStorage } = vi.hoisted(() => ({
  useApiResource: vi.fn(),
  useLocalStorage: vi.fn(() => [7, vi.fn(), true]),
}));
vi.mock("@/lib/api/use-api-resource", () => ({ useApiResource: () => useApiResource() }));
vi.mock("@/lib/use-local-storage", () => ({ useLocalStorage: () => useLocalStorage() }));

import { McpUsagePanel } from "@/components/site/app-panels/mcp-usage-panel";
import {
  formatMcpSuccessRate,
  mcpSuccessRate,
  mcpUsageHasSamples,
  mcpUsagePath,
  mcpUsageTotals,
  sortMcpUsageToolRows,
  type McpUsageDashboard,
} from "@/components/site/app-panels/mcp-usage-panel-model";

const DASHBOARD: McpUsageDashboard = {
  windowDays: 7,
  generatedAt: "2026-07-16T00:00:00.000Z",
  tools: [
    { tool: "predict_gate", total: 10, ok: 9, failed: 1, local: 6, remote: 4 },
    { tool: "build_plan", total: 4, ok: 4, failed: 0, local: 4, remote: 0 },
    // A never-called tool: its success rate must read "—", not 0%.
    { tool: "idle_tool", total: 0, ok: 0, failed: 0, local: 0, remote: 0 },
  ],
};

const EMPTY: McpUsageDashboard = {
  windowDays: 7,
  generatedAt: "2026-07-16T00:00:00.000Z",
  tools: [],
};

describe("mcp-usage-panel-model (#6241)", () => {
  it("mcpSuccessRate returns ok/total, and null for a tool with no calls", () => {
    expect(mcpSuccessRate({ total: 10, ok: 9 })).toBe(0.9);
    expect(mcpSuccessRate({ total: 0, ok: 0 })).toBeNull();
  });

  it("formatMcpSuccessRate renders whole percents and an em dash for null", () => {
    expect(formatMcpSuccessRate(0.9)).toBe("90%");
    expect(formatMcpSuccessRate(1)).toBe("100%");
    expect(formatMcpSuccessRate(null)).toBe("—");
  });

  it("sortMcpUsageToolRows orders by call count desc, ties broken by tool name", () => {
    const rows = sortMcpUsageToolRows([
      { tool: "b", total: 5, ok: 5, failed: 0, local: 5, remote: 0 },
      { tool: "a", total: 5, ok: 5, failed: 0, local: 5, remote: 0 },
      { tool: "c", total: 9, ok: 9, failed: 0, local: 9, remote: 0 },
    ]);
    expect(rows.map((r) => r.tool)).toEqual(["c", "a", "b"]);
  });

  it("sortMcpUsageToolRows does not mutate its input", () => {
    const input = [
      { tool: "a", total: 1, ok: 1, failed: 0, local: 1, remote: 0 },
      { tool: "b", total: 9, ok: 9, failed: 0, local: 9, remote: 0 },
    ];
    const snapshot = input.map((r) => r.tool);
    sortMcpUsageToolRows(input);
    expect(input.map((r) => r.tool)).toEqual(snapshot);
  });

  it("mcpUsageTotals sums every split across tools", () => {
    expect(mcpUsageTotals(DASHBOARD)).toEqual({
      total: 14,
      ok: 13,
      failed: 1,
      local: 10,
      remote: 4,
    });
    expect(mcpUsageTotals(EMPTY)).toEqual({ total: 0, ok: 0, failed: 0, local: 0, remote: 0 });
  });

  it("mcpUsageHasSamples is false for no tools and for tools that were all never called", () => {
    expect(mcpUsageHasSamples(DASHBOARD)).toBe(true);
    expect(mcpUsageHasSamples(EMPTY)).toBe(false);
    expect(
      mcpUsageHasSamples({
        ...EMPTY,
        tools: [{ tool: "x", total: 0, ok: 0, failed: 0, local: 0, remote: 0 }],
      }),
    ).toBe(false);
  });

  it("mcpUsagePath carries the selected window", () => {
    expect(mcpUsagePath(30)).toBe("/v1/app/mcp-usage?days=30");
  });
});

describe("McpUsagePanel (#6241)", () => {
  it("renders totals and a per-tool row, busiest first, with a never-called tool showing an em-dash success", () => {
    useApiResource.mockReturnValue({
      status: "ready",
      data: DASHBOARD,
      error: null,
      loadedAt: 1,
      reload: () => {},
    });
    render(<McpUsagePanel />);

    expect(screen.getByText("MCP tool usage")).toBeTruthy();
    // Fleet totals: 14 calls, 13/14 = 93% success.
    expect(screen.getByText("14")).toBeTruthy();
    expect(screen.getByText("93%")).toBeTruthy();
    // Per-tool rows are present; predict_gate (10 calls) sorts above build_plan (4).
    const toolCells = screen
      .getAllByText(/predict_gate|build_plan|idle_tool/)
      .map((el) => el.textContent);
    expect(toolCells[0]).toBe("predict_gate");
    // The never-called tool shows "—" rather than 0%.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows the empty state when there are zero recorded calls", () => {
    useApiResource.mockReturnValue({
      status: "ready",
      data: EMPTY,
      error: null,
      loadedAt: 1,
      reload: () => {},
    });
    render(<McpUsagePanel />);
    expect(screen.getByText(/No MCP tool calls recorded yet/i)).toBeTruthy();
  });

  it("surfaces a fetch error through the StateBoundary", () => {
    useApiResource.mockReturnValue({
      status: "error",
      data: null,
      error: "boom",
      errorKind: "network",
      loadedAt: null,
      reload: () => {},
    });
    render(<McpUsagePanel />);
    expect(screen.getByText(/Couldn't load MCP usage/i)).toBeTruthy();
  });

  it("shows a loading state before the first result arrives", () => {
    useApiResource.mockReturnValue({
      status: "loading",
      data: null,
      error: null,
      loadedAt: null,
      reload: () => {},
    });
    render(<McpUsagePanel />);
    // The window control renders even while loading, so the panel is interactive immediately.
    expect(screen.getByLabelText("MCP usage time window")).toBeTruthy();
  });
});
