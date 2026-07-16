import { AnalyticsCardShell } from "@/components/site/app-panels/analytics-card-shell";
import { StatusPill } from "@/components/site/control-primitives";
import { TableScroll } from "@/components/site/data-table";

/** One MCP tool's aggregate call counts over the dashboard's window. All counts are aggregate-only —
 *  no call arguments, repo names, or other per-call detail (matches the PostHog telemetry wrappers'
 *  own privacy boundary in `src/mcp/telemetry.ts` / `packages/loopover-mcp/lib/telemetry.js`). */
export type McpToolUsageEntry = {
  tool: string;
  callCount: number;
  successCount: number;
  failureCount: number;
  localCallCount: number;
  remoteCallCount: number;
};

export type McpToolUsageSummary = {
  windowDays: number;
  tools: McpToolUsageEntry[];
};

function successRate(entry: McpToolUsageEntry): number | null {
  return entry.callCount > 0 ? entry.successCount / entry.callCount : null;
}

function formatRate(rate: number | null): string {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/** Maintainer dashboard panel (#6241, part of #6228): per-tool MCP call counts, success/failure rates, and a
 *  local-vs-remote split, over the dashboard's selectable window. Backend aggregation (from the PostHog
 *  telemetry wrappers #6235/#6236/#6358 already write to) is tracked separately, so — matching
 *  AcceptanceRateCard's own precedent — this card assumes the field may be absent from the dashboard payload
 *  today and degrades to a "not yet available" empty state until it lands, rather than assuming a value. */
export function McpToolUsageCard({ usage }: { usage?: McpToolUsageSummary }) {
  if (!usage || usage.tools.length === 0) {
    return (
      <AnalyticsCardShell
        title="MCP tool usage"
        description="Per-tool call counts, success/failure rates, and local-vs-remote split."
        state="empty"
        emptyTitle={usage ? "No MCP tool calls yet" : "Not yet available"}
        emptyHint={
          usage
            ? "No loopover_* tool calls were recorded across local or remote servers in this window."
            : "Per-tool MCP usage appears here once tool-call telemetry is aggregated into the dashboard payload."
        }
      />
    );
  }

  const sorted = [...usage.tools].sort((a, b) => b.callCount - a.callCount);

  return (
    <AnalyticsCardShell
      title="MCP tool usage"
      description="Per-tool call counts, success/failure rates, and local-vs-remote split."
      state="ready"
    >
      <div className="mb-3 flex justify-end">
        <StatusPill status="info">{usage.windowDays}d window</StatusPill>
      </div>
      <TableScroll className="rounded-token border-hairline" label="MCP tool usage by tool">
        <table className="w-full text-left text-token-xs">
          <caption className="sr-only">
            Per-tool MCP call counts, success rate, and local vs. remote call split.
          </caption>
          <thead className="border-b-hairline font-mono uppercase tracking-wider text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-normal">
                Tool
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                Calls
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                Success rate
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                Local
              </th>
              <th scope="col" className="px-3 py-2 font-normal">
                Remote
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry) => (
              <tr key={entry.tool} className="border-b-hairline last:border-b-0">
                <td className="px-3 py-2 font-mono text-foreground/90">{entry.tool}</td>
                <td className="px-3 py-2">{entry.callCount}</td>
                <td className="px-3 py-2 text-muted-foreground">
                  {formatRate(successRate(entry))}
                </td>
                <td className="px-3 py-2 text-muted-foreground">{entry.localCallCount}</td>
                <td className="px-3 py-2 text-muted-foreground">{entry.remoteCallCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableScroll>
    </AnalyticsCardShell>
  );
}
