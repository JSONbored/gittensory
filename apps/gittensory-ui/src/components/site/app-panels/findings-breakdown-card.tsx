import { AnalyticsCardShell } from "@/components/site/app-panels/analytics-card-shell";
import { StatusPill } from "@/components/site/control-primitives";
import { cn } from "@/lib/utils";

/** Findings-by-category/severity breakdown (#2195): AI-review findings grouped by category, each split by
 *  severity tier. Display slice — it reads an optional `findings` breakdown off the operator-dashboard payload
 *  and shows "no findings in window" when the window is empty, or "not yet available" until the backend
 *  aggregation is wired, so it ships safely ahead of the feed and lights up automatically once it lands. */
export type FindingSeverityTier = "blocker" | "warning" | "advisory" | "nit";

export type FindingsCategoryBreakdown = {
  category: string;
  total: number;
  bySeverity: Partial<Record<FindingSeverityTier, number>>;
};

export type FindingsBreakdown = {
  windowDays: number;
  categories: FindingsCategoryBreakdown[];
};

/** Highest-severity first so a category's bar reads blocker → nit left-to-right. */
const SEVERITY_ORDER: FindingSeverityTier[] = ["blocker", "warning", "advisory", "nit"];

const SEVERITY_BAR: Record<FindingSeverityTier, string> = {
  blocker: "bg-danger",
  warning: "bg-warning",
  advisory: "bg-mint",
  nit: "bg-muted-foreground",
};

const SEVERITY_TEXT: Record<FindingSeverityTier, string> = {
  blocker: "text-danger",
  warning: "text-warning",
  advisory: "text-mint",
  nit: "text-muted-foreground",
};

function CategoryRow({ row }: { row: FindingsCategoryBreakdown }) {
  const segments = SEVERITY_ORDER.filter((tier) => (row.bySeverity[tier] ?? 0) > 0);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-token-sm">
        <span className="font-medium text-foreground">{row.category}</span>
        <span className="font-mono text-token-xs text-muted-foreground">{row.total}</span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-border" aria-hidden>
        {segments.map((tier) => (
          <div
            key={tier}
            className={cn("h-full", SEVERITY_BAR[tier])}
            style={{
              width: `${row.total > 0 ? ((row.bySeverity[tier] ?? 0) / row.total) * 100 : 0}%`,
            }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-token-2xs uppercase tracking-wider">
        {segments.map((tier) => (
          <span key={tier} className={SEVERITY_TEXT[tier]}>
            {tier} {row.bySeverity[tier]}
          </span>
        ))}
      </div>
    </div>
  );
}

export function FindingsBreakdownCard({ findings }: { findings?: FindingsBreakdown }) {
  const hasData = findings != null && findings.categories.length > 0;

  if (!hasData) {
    return (
      <AnalyticsCardShell
        title="Findings by category"
        description="AI-review findings grouped by category and severity."
        state="empty"
        emptyTitle={findings ? "No findings in window" : "Not yet available"}
        emptyHint={
          findings
            ? "No AI-review findings were recorded in the analytics window."
            : "The category breakdown appears once the findings feed is wired into the dashboard payload."
        }
      />
    );
  }

  return (
    <AnalyticsCardShell
      title="Findings by category"
      description="AI-review findings grouped by category and severity."
      state="ready"
    >
      <div className="flex items-center justify-end">
        <StatusPill status="info">{findings.windowDays}d window</StatusPill>
      </div>
      <div className="mt-3 space-y-4">
        {findings.categories.map((row) => (
          <CategoryRow key={row.category} row={row} />
        ))}
      </div>
    </AnalyticsCardShell>
  );
}
