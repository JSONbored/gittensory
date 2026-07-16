import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  McpToolUsageCard,
  type McpToolUsageSummary,
} from "@/components/site/app-panels/mcp-tool-usage-card";

const FORBIDDEN_PUBLIC_TERMS =
  /wallet|hotkey|coldkey|mnemonic|reward|payout|farming|raw trust|trust score|scoreability|credibility|private ranking/i;

function usage(overrides: Partial<McpToolUsageSummary> = {}): McpToolUsageSummary {
  return {
    windowDays: 30,
    tools: [
      {
        tool: "loopover_check_slop_risk",
        callCount: 40,
        successCount: 38,
        failureCount: 2,
        localCallCount: 30,
        remoteCallCount: 10,
      },
      {
        tool: "loopover_predict_gate",
        callCount: 10,
        successCount: 10,
        failureCount: 0,
        localCallCount: 0,
        remoteCallCount: 10,
      },
    ],
    ...overrides,
  };
}

describe("McpToolUsageCard (#6241)", () => {
  it("shows the 'not yet available' empty state when usage is undefined", () => {
    render(<McpToolUsageCard />);
    expect(screen.getByText("Not yet available")).toBeTruthy();
    expect(
      screen.getByText(
        "Per-tool MCP usage appears here once tool-call telemetry is aggregated into the dashboard payload.",
      ),
    ).toBeTruthy();
  });

  it("shows a distinct 'no calls yet' empty state when the payload exists but has zero tools", () => {
    render(<McpToolUsageCard usage={usage({ tools: [] })} />);
    expect(screen.getByText("No MCP tool calls yet")).toBeTruthy();
    expect(
      screen.getByText(
        "No loopover_* tool calls were recorded across local or remote servers in this window.",
      ),
    ).toBeTruthy();
  });

  it("renders one row per tool, sorted by call count descending, with success rate and local/remote split", () => {
    render(<McpToolUsageCard usage={usage()} />);
    expect(screen.getByText("30d window")).toBeTruthy();

    const table = screen.getByRole("table", {
      name: "Per-tool MCP call counts, success rate, and local vs. remote call split.",
    });
    const rows = within(table).getAllByRole("row").slice(1); // drop the header row
    expect(rows).toHaveLength(2);
    // Sorted descending by callCount: loopover_check_slop_risk (40) before loopover_predict_gate (10).
    expect(within(rows[0]!).getByText("loopover_check_slop_risk")).toBeTruthy();
    expect(within(rows[0]!).getByText("95%")).toBeTruthy(); // 38/40
    expect(within(rows[1]!).getByText("loopover_predict_gate")).toBeTruthy();
    expect(within(rows[1]!).getByText("100%")).toBeTruthy(); // 10/10
  });

  it("shows a dash success rate for a tool with zero calls (never divides by zero)", () => {
    render(
      <McpToolUsageCard
        usage={usage({
          tools: [
            {
              tool: "loopover_lint_pr_text",
              callCount: 0,
              successCount: 0,
              failureCount: 0,
              localCallCount: 0,
              remoteCallCount: 0,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("—")).toBeTruthy();
  });

  it("wraps the table in a keyboard-focusable, labelled scroll region (#794 a11y pattern)", () => {
    render(<McpToolUsageCard usage={usage()} />);
    const region = screen.getByRole("region", { name: "MCP tool usage by tool" });
    expect(region.tabIndex).toBe(0);
    const table = within(region).getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Tool" })).toBeTruthy();
    expect(within(table).getByRole("columnheader", { name: "Success rate" })).toBeTruthy();
  });

  it("never surfaces forbidden reward/wallet/score terms", () => {
    const { container } = render(<McpToolUsageCard usage={usage()} />);
    expect(container.textContent ?? "").not.toMatch(FORBIDDEN_PUBLIC_TERMS);
  });
});
