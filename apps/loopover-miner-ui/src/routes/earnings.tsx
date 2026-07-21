import { createFileRoute } from "@tanstack/react-router";

import { Card, CardContent } from "@loopover/ui-kit/components/card";
import { EmptyState } from "@loopover/ui-kit/components/state-views";

export const Route = createFileRoute("/earnings")({
  component: EarningsPage,
});

// Earnings / emissions slot (#7673): a navigation and layout reservation only. Real per-miner earnings data
// is blocked on an external settlement decision — this route must not fetch, invent numbers, or assume which
// settlement model lands. Keep the empty copy honest so the slot can later be wired without a nav redesign.

export function EarningsPage() {
  return (
    <section className="grid gap-4" aria-labelledby="earnings-heading">
      <div className="grid gap-1">
        <h2 id="earnings-heading" className="font-display text-token-xl font-semibold">
          Earnings — not yet available
        </h2>
        <p className="text-token-sm text-muted-foreground">
          Reserved slot for per-miner earnings once the external settlement model is decided.
        </p>
      </div>
      <Card>
        <CardContent className="pt-6">
          <EmptyState
            title="Not yet available"
            description="This page is a placeholder only — it does not load or display earnings data."
          />
        </CardContent>
      </Card>
    </section>
  );
}
