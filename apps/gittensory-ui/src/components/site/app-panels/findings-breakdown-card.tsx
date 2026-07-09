import { Stat, StatusPill } from "@/components/site/control-primitives";
import { EmptyState } from "@/components/site/state-views";

import {
  categoryTotal,
  totalFindingsBreakdown,
  type FindingsBreakdownReport,
} from "./findings-breakdown-card-model";

/** Self-host analytics card (#2195): AI-review findings broken down by category and severity over a rolling
 *  window. Aggregate high/medium/low Stat tiles on top, then one row per category with its per-severity counts
 *  (colored by design tokens, never raw hex). Renders a graceful EmptyState when there are no findings in the
 *  window. Read-only, public-safe counts only. */
export function FindingsBreakdownCard({ report }: { report: FindingsBreakdownReport }) {
  const totals = totalFindingsBreakdown(report);
  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">Findings by category</h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            AI-review findings grouped by category and severity. Public-safe counts only.
          </p>
        </div>
        <StatusPill status={totals.total > 0 ? "ready" : "info"}>
          {`${report.windowDays}-day window`}
        </StatusPill>
      </div>
      {totals.total === 0 ? (
        <EmptyState
          className="mt-4"
          title="No findings in window"
          description="Nothing has been flagged in the selected window yet."
        />
      ) : (
        <>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <Stat label="High" value={String(totals.high)} />
            <Stat label="Medium" value={String(totals.medium)} />
            <Stat label="Low" value={String(totals.low)} />
          </div>
          <ul className="mt-3 space-y-2">
            {report.categories.map((row) => (
              <li
                key={row.category}
                className="flex items-center justify-between gap-3 rounded-token border border-border p-3"
              >
                <div className="text-token-sm text-foreground">{row.category}</div>
                <div className="flex items-center gap-3 font-mono text-token-xs">
                  <span className="text-danger">{row.high} high</span>
                  <span className="text-warning">{row.medium} med</span>
                  <span className="text-muted-foreground">{row.low} low</span>
                  <span className="text-foreground">{categoryTotal(row)} total</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
