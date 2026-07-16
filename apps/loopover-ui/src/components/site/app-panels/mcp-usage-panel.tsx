import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { AnalyticsCardShell } from "@/components/site/app-panels/analytics-card-shell";
import {
  formatMcpSuccessRate,
  MCP_USAGE_WINDOW_STORAGE_KEY,
  mcpSuccessRate,
  mcpUsageHasSamples,
  mcpUsagePath,
  mcpUsageTotals,
  sortMcpUsageToolRows,
  type McpUsageDashboard,
} from "@/components/site/app-panels/mcp-usage-panel-model";
import { StatCard } from "@/components/site/primitives";
import { RefreshMeta } from "@/components/site/refresh-meta";
import { StateBoundary } from "@/components/site/state-views";
import {
  ANALYTICS_WINDOW_OPTIONS,
  DEFAULT_ANALYTICS_WINDOW_DAYS,
  parseAnalyticsWindowDays,
  type AnalyticsWindowDays,
} from "@/lib/analytics-window";
import { useApiResource } from "@/lib/api/use-api-resource";
import { useLocalStorage } from "@/lib/use-local-storage";

/** #6241: per-tool MCP usage for maintainers -- call counts, success rate, and a local-vs-remote split over a
 *  selectable window -- so the telemetry recorded by #6228 is visible in-app instead of only in PostHog.
 *  Self-contained: it fetches its own data, so it can sit next to MaintainerPanel without threading through the
 *  maintainer-dashboard aggregate. */
export function McpUsagePanel() {
  const [windowDays, setWindowDays, windowHydrated] = useLocalStorage<AnalyticsWindowDays>(
    MCP_USAGE_WINDOW_STORAGE_KEY,
    DEFAULT_ANALYTICS_WINDOW_DAYS,
  );
  const selectedWindow = parseAnalyticsWindowDays(windowDays);
  const usage = useApiResource<McpUsageDashboard>(mcpUsagePath(selectedWindow), "MCP tool usage");
  const data = usage.status === "ready" ? usage.data : null;

  return (
    <section className="grid gap-4 rounded-token border border-border bg-transparent p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold tracking-tight">
            MCP tool usage
          </h2>
          <p className="mt-1 max-w-2xl text-token-sm text-muted-foreground">
            Per-tool call counts, success rate, and the local-vs-remote split across the selected
            window.
          </p>
        </div>
        {windowHydrated ? (
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={String(selectedWindow)}
            onValueChange={(value) => {
              if (!value) return;
              setWindowDays(parseAnalyticsWindowDays(Number(value)));
            }}
            aria-label="MCP usage time window"
          >
            {ANALYTICS_WINDOW_OPTIONS.map((days) => (
              <ToggleGroupItem key={days} value={String(days)} aria-label={`${days} day window`}>
                {days}d
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
      </header>

      <StateBoundary
        isLoading={usage.status === "loading"}
        isError={usage.status === "error"}
        isEmpty={data !== null && !mcpUsageHasSamples(data)}
        errorKind={usage.status === "error" ? usage.errorKind : undefined}
        errorLabel="MCP usage"
        onRetry={usage.reload}
        errorTitle="Couldn't load MCP usage"
        emptyTitle="No MCP tool calls recorded yet"
        emptyDescription="Once maintainers opt in and tools are called, per-tool usage appears here."
      >
        {data ? (
          <McpUsageContent data={data} loadedAt={usage.loadedAt} onRefresh={usage.reload} />
        ) : null}
      </StateBoundary>
    </section>
  );
}

function McpUsageContent({
  data,
  loadedAt,
  onRefresh,
}: {
  data: McpUsageDashboard;
  loadedAt: number | null;
  onRefresh: () => void;
}) {
  const totals = mcpUsageTotals(data);
  const rows = sortMcpUsageToolRows(data.tools);

  return (
    <div className="grid gap-4">
      <div className="flex justify-end">
        <RefreshMeta loadedAt={loadedAt} onRefresh={onRefresh} />
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total calls" value={String(totals.total)} />
        <StatCard label="Success rate" value={formatMcpSuccessRate(mcpSuccessRate(totals))} />
        <StatCard label="Local" value={String(totals.local)} />
        <StatCard label="Remote" value={String(totals.remote)} />
      </section>

      <AnalyticsCardShell
        title="Per-tool usage"
        state={rows.length === 0 ? "empty" : "ready"}
        emptyHint="No tools were called in this window."
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead>Calls</TableHead>
              <TableHead>Success</TableHead>
              <TableHead>Local</TableHead>
              <TableHead>Remote</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.tool}>
                <TableCell className="font-mono text-foreground">{row.tool}</TableCell>
                <TableCell>{row.total}</TableCell>
                <TableCell>{formatMcpSuccessRate(mcpSuccessRate(row))}</TableCell>
                <TableCell>{row.local}</TableCell>
                <TableCell>{row.remote}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </AnalyticsCardShell>
    </div>
  );
}
