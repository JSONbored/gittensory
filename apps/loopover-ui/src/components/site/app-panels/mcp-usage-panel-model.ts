// #6241: the consumption side of the #6228 MCP telemetry work. The recorded event carries exactly four fields
// (tool, caller_type, ok, duration_ms -- see packages/loopover-mcp/lib/telemetry.js and src/mcp/telemetry.ts);
// this panel shows their per-tool aggregate. Pure model + types live here so the component file only exports
// components (react-refresh/only-export-components), mirroring gate-outcome-card-model.ts.
import type { AnalyticsWindowDays } from "@/lib/analytics-window";

/** One tool's aggregated call counts over the selected window. `local` + `remote` sum to `total`, and so do
 *  `ok` + `failed` -- the two are independent splits of the same calls (by surface, and by outcome). */
export type McpUsageToolRow = {
  tool: string;
  total: number;
  ok: number;
  failed: number;
  local: number;
  remote: number;
};

/** The per-tool MCP usage payload this panel consumes. Shape is defined ahead of the production endpoint (#6241
 *  is explicitly not blocked on the telemetry writers shipping), so the panel is buildable and testable now. */
export type McpUsageDashboard = {
  windowDays: number;
  generatedAt: string;
  tools: McpUsageToolRow[];
};

/** The API path this panel fetches, carrying the selected window the same way operatorDashboardPath does. */
export function mcpUsagePath(windowDays: AnalyticsWindowDays): string {
  return `/v1/app/mcp-usage?days=${windowDays}`;
}

/** localStorage key for the panel's own window selection -- distinct from the analytics window so the two
 *  surfaces remember independent choices. */
export const MCP_USAGE_WINDOW_STORAGE_KEY = "loopover.mcp-usage.windowDays";

/** A success rate in [0,1], or null when there are no calls in the window (so the UI shows "—" rather than a
 *  misleading 0% for a tool that was simply never invoked). Takes just the two counts it needs, so it serves both
 *  a single tool row and the computed fleet totals. */
export function mcpSuccessRate(counts: { total: number; ok: number }): number | null {
  return counts.total === 0 ? null : counts.ok / counts.total;
}

/** Render a [0,1] rate as a whole-percent string; null (no samples) becomes an em dash. */
export function formatMcpSuccessRate(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/** Tools ordered for display: busiest first, ties broken by name so the order is stable across reloads
 *  (a plain count sort would let two equal-count tools swap places between fetches). */
export function sortMcpUsageToolRows(rows: readonly McpUsageToolRow[]): McpUsageToolRow[] {
  return [...rows].sort((a, b) => b.total - a.total || a.tool.localeCompare(b.tool));
}

/** Fleet totals across every tool: the header stat row. Computed rather than trusted from the payload so the
 *  displayed totals can never disagree with the rows beneath them. */
export function mcpUsageTotals(dashboard: McpUsageDashboard): {
  total: number;
  ok: number;
  failed: number;
  local: number;
  remote: number;
} {
  return dashboard.tools.reduce(
    (acc, row) => ({
      total: acc.total + row.total,
      ok: acc.ok + row.ok,
      failed: acc.failed + row.failed,
      local: acc.local + row.local,
      remote: acc.remote + row.remote,
    }),
    { total: 0, ok: 0, failed: 0, local: 0, remote: 0 },
  );
}

/** True when there is at least one recorded call to show. A payload with tools that all have zero calls (or no
 *  tools at all) is treated as empty, so the panel shows its empty state instead of a table of zeros. */
export function mcpUsageHasSamples(dashboard: McpUsageDashboard): boolean {
  return mcpUsageTotals(dashboard).total > 0;
}
