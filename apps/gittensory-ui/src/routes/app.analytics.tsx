import { createFileRoute } from "@tanstack/react-router";

import { BoundaryBadge, Stat, StatusPill } from "@/components/site/control-primitives";
import { StateBoundary, usePreviewDataState } from "@/components/site/state-views";
import { TrendChart } from "@/components/site/trend-chart";
import { mockAnalytics, mockAnalyticsClients, mockAnalyticsCommands } from "@/lib/api/mock";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/app/analytics")({
  component: ProductAnalytics,
});

function ProductAnalytics() {
  const state = usePreviewDataState("Product analytics");

  return (
    <StateBoundary
      isLoading={state.isLoading}
      isEmpty={mockAnalytics.length === 0}
      onRetry={state.retry}
      onRefresh={state.refresh}
      loadingTitle="Loading analytics…"
      emptyTitle="No analytics yet"
      emptyDescription="Aggregate adoption and command usage metrics will appear once the API has data."
    >
      <div className="space-y-8">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="font-mono text-token-2xs uppercase tracking-wider text-mint">
              Roadmap · shipping soon
            </div>
            <h1 className="mt-1 font-display text-token-2xl font-semibold tracking-tight">
              Product analytics
            </h1>
            <p className="mt-1 max-w-2xl text-token-sm text-muted-foreground">
              Adoption, command usage, and noise-reduction trends across the Gittensory deployment.
              All counts are aggregate — no per-user PII.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill status="ready">Signal · ready</StatusPill>
            <BoundaryBadge boundary="private-api" />
          </div>
        </header>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {mockAnalytics.map((s) => (
            <Stat
              key={s.label}
              label={s.label}
              value={s.total}
              hint={
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="text-mint">{s.delta}</span>
                  <div className="h-8 w-28">
                    <TrendChart values={s.values} height={32} />
                  </div>
                </div>
              }
            />
          ))}
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <BreakdownCard title="MCP client mix" data={mockAnalyticsClients} />
          <BreakdownCard title="Command usage" data={mockAnalyticsCommands} />
        </section>

        <section className="rounded-token border border-border bg-transparent p-5">
          <h2 className="font-display text-token-lg font-semibold">8-week adoption trend</h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            MCP installs vs branch analyses run vs @gittensory commands.
          </p>
          <div className="mt-4 grid gap-6 lg:grid-cols-3">
            {[mockAnalytics[0], mockAnalytics[2], mockAnalytics[3]].map((s) => (
              <div
                key={s.label}
                className="rounded-token border border-border bg-background/40 p-3"
              >
                <div className="flex items-center justify-between text-token-xs">
                  <span className="text-muted-foreground">{s.label}</span>
                  <span className="font-mono text-mint">{s.delta}</span>
                </div>
                <div className="mt-3 h-20 w-full">
                  <TrendChart values={s.values} height={80} />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </StateBoundary>
  );
}

function BreakdownCard({
  title,
  data,
}: {
  title: string;
  data: Array<{ label: string; share: number }>;
}) {
  return (
    <div className="rounded-token border border-border bg-transparent p-5">
      <h2 className="font-display text-token-lg font-semibold">{title}</h2>
      <ul className="mt-4 space-y-2.5">
        {data.map((d) => (
          <li key={d.label}>
            <div className="flex items-center justify-between text-token-sm">
              <span className="text-foreground/90">{d.label}</span>
              <span className="font-mono text-token-xs text-muted-foreground">
                {(d.share * 100).toFixed(0)}%
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-border/60">
              <div
                className={cn("h-full rounded-full bg-mint")}
                style={{ width: `${d.share * 100}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
