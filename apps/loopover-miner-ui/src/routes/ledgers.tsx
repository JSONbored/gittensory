import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Button } from "@loopover/ui-kit/components/button";
import { Card, CardContent, CardHeader } from "@loopover/ui-kit/components/card";
import { Input } from "@loopover/ui-kit/components/input";
import { Skeleton } from "@loopover/ui-kit/components/skeleton";
import { StateBoundary } from "@loopover/ui-kit/components/state-views";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@loopover/ui-kit/components/table";

import {
  CLAIM_STATUSES,
  fetchLedgers,
  type ClaimStatus,
  type LedgersResult,
  type LedgersSummary,
} from "../lib/ledgers";
import { fetchGovernorPauseState, pauseGovernor, resumeGovernor, type GovernorPauseStateResult } from "../lib/governor";

export const Route = createFileRoute("/ledgers")({
  component: LedgersPage,
});

// Read-only views over the miner's local claim / event / governor ledgers (#4855). All three are aggregated
// server-side (see vite-ledgers-api.ts) to status/type counts plus a small feed of SAFE columns — raw payloads
// and the free-text claim note never reach this component. Same 4-state pattern as the portfolio/run-history
// views (loading / error / fresh-install empty / populated), now rendered through ui-kit's shared StateBoundary
// / LoadingState / ErrorState primitives with content-shaped Skeletons instead of hand-rolled plain text (#6512).
//
// The governor control section below is a SEPARATE fetch/action loop from the read-only ledger summary above
// (#4857, the governor half): it reads/writes the governor's pause state via vite-governor-api.ts, the
// miner-ui's first write-capable endpoint, safe only because vite-auth.ts (#4858) now authenticates every
// /api/* request. It does not touch, and is unrelated to, the governor EVENT ledger already shown below. Its
// read has its OWN StateBoundary so a governor-state fetch failure never blocks the ledger summary, and the
// pause/resume write path (lib/governor.ts + the Button click handlers) is deliberately left untouched (#6512).

const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  active: "Active",
  released: "Released",
  expired: "Expired",
};

const CLAIM_STATUS_TONE: Record<ClaimStatus, string> = {
  active: "text-[var(--success)]",
  released: "text-muted-foreground",
  expired: "text-[var(--warning)]",
};

function CountTable({ counts, keyLabel }: { counts: Record<string, number>; keyLabel: string }) {
  const entries = Object.entries(counts).sort(([, a], [, b]) => b - a);
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{keyLabel}</TableHead>
          <TableHead>Count</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map(([type, count]) => (
          <TableRow key={type}>
            <TableCell className="font-mono text-foreground">{type}</TableCell>
            <TableCell>{count}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// Content-shaped placeholder for the governor-control panel: a status line plus the input/button row, so the
// layout doesn't jump once the pause state arrives.
function GovernorControlSkeleton() {
  return (
    <div className="grid gap-3 rounded-token border border-border bg-transparent p-4" aria-hidden>
      <Skeleton className="h-4 w-40" />
      <div className="flex flex-wrap items-center gap-3">
        <Skeleton className="h-9 min-w-[12rem] flex-1 rounded-token" />
        <Skeleton className="h-8 w-32 rounded-token" />
      </div>
    </div>
  );
}

// Content-shaped placeholder for the ledger summary: the three claim count-cards plus a couple of table blocks,
// approximating the eventual card-grid + table layout rather than a single generic bar.
function LedgerSummarySkeleton() {
  return (
    <div className="grid gap-6" aria-hidden>
      <section className="grid gap-3">
        <Skeleton className="h-5 w-32" />
        <div className="grid gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="grid gap-2 rounded-token border border-border p-4">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-8 w-12" />
            </div>
          ))}
        </div>
      </section>
      {Array.from({ length: 2 }, (_, section) => (
        <section key={section} className="grid gap-3">
          <Skeleton className="h-5 w-40" />
          <div className="grid gap-2">
            {Array.from({ length: 3 }, (_, row) => (
              <Skeleton key={row} className="h-6 w-full" />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function GovernorControlSection({
  result,
  pending,
  onPause,
  onResume,
}: {
  result: GovernorPauseStateResult | null;
  pending: boolean;
  onPause: (reason?: string) => void;
  onResume: () => void;
}) {
  // Optional pause reason, mirroring the CLI's `governor pause [--reason <text>]`; an empty field
  // is passed through as `undefined` so it matches the CLI's own optional-flag behavior.
  const [reason, setReason] = useState("");
  const pauseState = result?.ok ? result.pauseState : null;
  const governorError = result !== null && !result.ok ? result.error : null;
  return (
    <section className="grid gap-3">
      <h3 className="font-display text-token-base font-semibold">Governor control</h3>
      <StateBoundary
        isLoading={result === null}
        isError={governorError !== null}
        loadingSkeleton={<GovernorControlSkeleton />}
        errorTitle="Couldn't read the governor state"
        errorDescription={governorError ? `Could not read the local governor state: ${governorError}` : undefined}
      >
        {pauseState && (
          <div className="grid gap-3 rounded-token border border-border bg-transparent p-4">
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className={`size-2 shrink-0 rounded-full ${pauseState.paused ? "bg-[var(--warning)]" : "bg-[var(--success)]"}`}
              />
              <p className="text-token-sm text-muted-foreground">
                {pauseState.paused
                  ? `Paused since ${pauseState.pausedAt}${pauseState.reason ? ` (${pauseState.reason})` : ""}`
                  : "Not paused"}
              </p>
            </div>
            {pauseState.paused ? (
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" variant="outline" disabled={pending} onClick={onResume}>
                  Resume governor
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <Input
                  type="text"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  disabled={pending}
                  placeholder="Reason (optional)"
                  aria-label="Pause reason"
                  className="w-auto flex-1 min-w-[12rem]"
                />
                <Button size="sm" variant="destructive" disabled={pending} onClick={() => onPause(reason || undefined)}>
                  Pause governor
                </Button>
              </div>
            )}
          </div>
        )}
      </StateBoundary>
    </section>
  );
}

function LedgerSummary({ summary }: { summary: LedgersSummary }) {
  const { claims, events, governor } = summary;
  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <h3 className="font-display text-token-base font-semibold">Claims ({claims.total})</h3>
        <dl className="grid gap-4 sm:grid-cols-3">
          {CLAIM_STATUSES.map((status) => (
            <Card key={status}>
              <CardContent className="p-4">
                <dt className="text-token-2xs uppercase tracking-wider text-muted-foreground">
                  {CLAIM_STATUS_LABELS[status]}
                </dt>
                <dd className={`mt-1 text-token-3xl font-display font-semibold ${CLAIM_STATUS_TONE[status]}`}>
                  {claims.byStatus[status]}
                </dd>
              </CardContent>
            </Card>
          ))}
        </dl>
      </section>

      <section className="grid gap-3">
        <h3 className="font-display text-token-base font-semibold">Governor events ({governor.total})</h3>
        {governor.total === 0 ? (
          <p className="text-token-sm text-muted-foreground">No governor events recorded.</p>
        ) : (
          <CountTable counts={governor.byEventType} keyLabel="Event type" />
        )}
      </section>

      <section className="grid gap-3">
        <h3 className="font-display text-token-base font-semibold">Events by type ({events.total})</h3>
        {events.total === 0 ? (
          <p className="text-token-sm text-muted-foreground">No events recorded.</p>
        ) : (
          <CountTable counts={events.byType} keyLabel="Event type" />
        )}
      </section>

      <section className="grid gap-3">
        <h3 className="font-display text-token-base font-semibold">Recent events ({events.total})</h3>
        {events.recent.length === 0 ? (
          <p className="text-token-sm text-muted-foreground">No event-ledger entries recorded.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event type</TableHead>
                <TableHead>Repository</TableHead>
                <TableHead>Recorded</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.recent.map((entry, index) => (
                <TableRow key={`${entry.eventType}-${entry.createdAt ?? index}`}>
                  <TableCell className="font-mono text-foreground">{entry.eventType}</TableCell>
                  <TableCell className="font-mono">{entry.repoFullName ?? "—"}</TableCell>
                  <TableCell>{entry.createdAt ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

export function LedgersView({ result }: { result: LedgersResult | null }) {
  const summary = result?.ok ? result.summary : null;
  const ledgersError = result !== null && !result.ok ? result.error : null;
  const isEmpty =
    summary !== null && summary.claims.total === 0 && summary.events.total === 0 && summary.governor.total === 0;
  return (
    <StateBoundary
      isLoading={result === null}
      isError={ledgersError !== null}
      isEmpty={isEmpty}
      loadingSkeleton={<LedgerSummarySkeleton />}
      errorTitle="Couldn't read the local ledgers"
      errorDescription={ledgersError ? `Could not read the local ledgers: ${ledgersError}` : undefined}
      emptyTitle="No ledger activity yet"
      emptyDescription="Claims, events, and governor entries appear here once the miner starts working."
    >
      {summary && <LedgerSummary summary={summary} />}
    </StateBoundary>
  );
}

export function LedgersPage({
  loadLedgers = fetchLedgers,
  loadGovernorPauseState = fetchGovernorPauseState,
  pauseGovernorAction = pauseGovernor,
  resumeGovernorAction = resumeGovernor,
}: {
  loadLedgers?: () => Promise<LedgersResult>;
  loadGovernorPauseState?: () => Promise<GovernorPauseStateResult>;
  pauseGovernorAction?: (reason?: string) => Promise<GovernorPauseStateResult>;
  resumeGovernorAction?: () => Promise<GovernorPauseStateResult>;
}) {
  const [result, setResult] = useState<LedgersResult | null>(null);
  const [pauseState, setPauseState] = useState<GovernorPauseStateResult | null>(null);
  const [actionPending, setActionPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadLedgers().then((loaded) => {
      if (!cancelled) setResult(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [loadLedgers]);

  useEffect(() => {
    let cancelled = false;
    void loadGovernorPauseState().then((loaded) => {
      if (!cancelled) setPauseState(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [loadGovernorPauseState]);

  const runGovernorAction = (action: () => Promise<GovernorPauseStateResult>) => {
    setActionPending(true);
    void action().then((next) => {
      setPauseState(next);
      setActionPending(false);
    });
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="font-display text-token-lg font-semibold">Ledgers</h2>
        <p className="text-token-sm text-muted-foreground">
          Local, read-only summary of the miner&apos;s claim, event, and governor ledgers.
        </p>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6">
          <GovernorControlSection
            result={pauseState}
            pending={actionPending}
            onPause={(reason) => runGovernorAction(() => pauseGovernorAction(reason))}
            onResume={() => runGovernorAction(resumeGovernorAction)}
          />
          <LedgersView result={result} />
        </div>
      </CardContent>
    </Card>
  );
}
