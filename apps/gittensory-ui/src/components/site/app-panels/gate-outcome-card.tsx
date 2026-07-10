import { Stat, StatusPill } from "@/components/site/control-primitives";
import { EmptyState } from "@/components/site/state-views";

import {
  bandForGateOutcomes,
  summarizeGateOutcomes,
  type GateOutcomeBreakdown,
} from "./gate-outcome-card-model";

/** Maintainer-dashboard card (#2203): the gate-outcome breakdown — how the maintainer's repos' PRs resolved
 *  (auto-merged / auto-closed / held for manual review) over a rolling window, as three count tiles plus a small
 *  stacked-proportion bar in token colors. UI-only display slice; the breakdown is assumed present on the
 *  maintainer-dashboard payload (shaped by the #539 dashboard service), so absence renders a graceful "not yet
 *  available" EmptyState. Public-safe counts only — no scores, rewards, or wallet fields. */
export function GateOutcomeCard({ breakdown }: { breakdown?: GateOutcomeBreakdown }) {
  if (!breakdown) {
    return (
      <EmptyState
        title="Gate outcomes not yet available"
        description="This appears once gate-outcome data is present on the maintainer-dashboard payload."
      />
    );
  }
  const summary = summarizeGateOutcomes(breakdown);
  return (
    <section className="rounded-token border border-border bg-transparent p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">Gate-outcome breakdown</h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            How your repositories&rsquo; PRs resolved — auto-merged, auto-closed, or held for manual
            review. Public-safe counts only.
          </p>
        </div>
        <StatusPill
          status={bandForGateOutcomes(breakdown)}
        >{`${breakdown.windowDays}-day window`}</StatusPill>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Stat
          label="Auto-merged"
          value={String(summary.merged)}
          hint={
            <span className="text-muted-foreground">{`${summary.mergedPct}% of outcomes`}</span>
          }
        />
        <Stat
          label="Auto-closed"
          value={String(summary.closed)}
          hint={
            <span className="text-muted-foreground">{`${summary.closedPct}% of outcomes`}</span>
          }
        />
        <Stat
          label="Held / manual"
          value={String(summary.held)}
          hint={<span className="text-muted-foreground">{`${summary.heldPct}% of outcomes`}</span>}
        />
      </div>
      {summary.total > 0 ? (
        <div className="mt-4 flex h-2 overflow-hidden rounded-token" aria-hidden="true">
          <div className="bg-mint" style={{ width: `${summary.mergedPct}%` }} />
          <div className="bg-danger" style={{ width: `${summary.closedPct}%` }} />
          <div className="bg-warning" style={{ width: `${summary.heldPct}%` }} />
        </div>
      ) : (
        <div className="mt-4">
          <EmptyState
            title="No gate outcomes yet"
            description="No PR reached an auto-merge, auto-close, or hold in this window."
          />
        </div>
      )}
    </section>
  );
}
