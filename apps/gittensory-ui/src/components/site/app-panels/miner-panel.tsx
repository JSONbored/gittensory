import { Link } from "@tanstack/react-router";

import { KeyValueGrid, StatusPill, type Status } from "@/components/site/control-primitives";
import { McpVersionBadge } from "@/components/site/mcp-version-badge";
import { StatCard } from "@/components/site/primitives";
import { StateBoundary, usePreviewDataState } from "@/components/site/state-views";
import { mockBlockers, mockNextActions, mockProjections, mockRepoFit } from "@/lib/api/mock";

const LANE_TONE: Record<string, Status> = {
  pursue: "ready",
  "cleanup-first": "warn",
  "maintainer-lane": "info",
  avoid: "blocked",
};

const SCORE_LABEL: Record<string, string> = {
  ready: "Scoreable",
  "blocked-gated": "Gated",
  "after-pending": "After pending",
  "linked-issue-needed": "Needs linked issue",
  "best-reasonable": "Best reasonable",
};

export function MinerPanel() {
  const state = usePreviewDataState("Miner decision pack");
  const isEmpty = mockNextActions.length === 0 && mockBlockers.length === 0;

  return (
    <StateBoundary
      isLoading={state.isLoading}
      isEmpty={isEmpty}
      onRetry={state.retry}
      onRefresh={state.refresh}
      loadingTitle="Loading miner signals…"
      emptyTitle="No miner actions yet"
      emptyDescription="Once a decision pack or branch analysis exists, ranked next actions and blockers will appear here."
    >
      <div className="space-y-6">
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            label="Next actions"
            value={mockNextActions.length}
            hint="ranked from decision pack"
          />
          <StatCard
            label="Open blockers"
            value={mockBlockers.reduce((n, g) => n + g.items.length, 0)}
            hint="across all groups"
          />
          <StatCard label="Open PR pressure" value="1 / 1" hint="queue capacity reached" />
          <StatCard
            label="Repos in fit"
            value={mockRepoFit.filter((r) => r.lane === "pursue").length}
            hint="pursue lane"
          />
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="rounded-token border-hairline bg-card p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-display text-token-lg font-semibold">Next actions</h2>
              <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                ranked
              </span>
            </div>
            <ol className="space-y-3">
              {mockNextActions.map((a, i) => (
                <li
                  key={a.id}
                  className="rounded-token border-hairline bg-background/40 p-4 transition-colors hover:border-strong"
                >
                  <div className="flex items-start gap-3">
                    <span className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-token border-hairline bg-card font-mono text-token-2xs text-muted-foreground">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-medium text-foreground">{a.title}</h3>
                        <StatusPill status={LANE_TONE[a.lane]}>{a.lane}</StatusPill>
                        <StatusPill status={a.scoreability === "ready" ? "ready" : "warn"}>
                          {SCORE_LABEL[a.scoreability]}
                        </StatusPill>
                      </div>
                      <p className="mt-1 text-token-sm text-muted-foreground leading-token-relaxed">
                        {a.rationale}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-token-2xs text-muted-foreground">
                        <span>{a.repo}</span>
                        {a.evidence.map((e) => (
                          <span key={e} className="rounded-token border-hairline px-1.5 py-0.5">
                            {e}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>

          <div className="space-y-6">
            <div className="rounded-token border-hairline bg-card p-5">
              <h2 className="font-display text-token-lg font-semibold">Scoreability projections</h2>
              <p className="mt-1 text-token-xs text-muted-foreground">
                Underlying potential vs. gated reality. Not a payout estimate.
              </p>
              <div className="mt-4 space-y-3">
                {mockProjections.map((p) => (
                  <div key={p.name}>
                    <div className="flex items-center justify-between text-token-xs">
                      <span className="text-foreground/90">{p.label}</span>
                      <span className="font-mono text-muted-foreground">
                        {Math.round(p.weight * 100)}
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-mint transition-all duration-500"
                        style={{ width: `${p.weight * 100}%` }}
                      />
                    </div>
                    <div className="mt-1 text-token-2xs text-muted-foreground">{p.note}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-token border-hairline bg-card p-5">
              <h2 className="font-display text-token-lg font-semibold">MCP status</h2>
              <div className="mt-3 flex items-center gap-2">
                <McpVersionBadge />
                <StatusPill status="ready">doctor: ok</StatusPill>
              </div>
              <KeyValueGrid
                className="mt-4"
                rows={[
                  { k: "Snapshot", v: "rs_2026_05_29_a1f3" },
                  { k: "Drift", v: "none detected" },
                  { k: "Last run", v: "11:42 UTC" },
                ]}
              />
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-token border-hairline bg-card p-5">
            <h2 className="font-display text-token-lg font-semibold">Scoreability blockers</h2>
            <p className="mt-1 text-token-xs text-muted-foreground">
              Each blocker links to how to clear it.{" "}
              <Link
                to="/docs/scoreability"
                className="text-mint underline-offset-4 hover:underline"
              >
                See scoreability docs →
              </Link>
            </p>
            <div className="mt-4 space-y-4">
              {mockBlockers.map((g) => (
                <div key={g.group}>
                  <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                    {g.group}
                  </div>
                  <ul className="mt-2 space-y-2">
                    {g.items.map((it) => (
                      <li
                        key={it.code}
                        className="rounded-token border-hairline bg-background/40 px-3 py-2 transition-colors hover:border-strong"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-token-sm text-foreground">{it.title}</span>
                          <code className="font-mono text-token-2xs text-muted-foreground">
                            {it.code}
                          </code>
                        </div>
                        <p className="mt-1 text-token-xs text-muted-foreground">
                          {it.how_to_clear}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-token border-hairline bg-card p-5">
            <h2 className="font-display text-token-lg font-semibold">Repo fit</h2>
            <p className="mt-1 text-token-xs text-muted-foreground">
              Where to spend time — and where not to.
            </p>
            <table className="mt-4 w-full text-left text-token-sm">
              <thead>
                <tr className="border-b-hairline font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                  <th className="py-2 pr-3 font-normal">Repo</th>
                  <th className="py-2 pr-3 font-normal">Lane</th>
                  <th className="py-2 font-normal">Why</th>
                </tr>
              </thead>
              <tbody>
                {mockRepoFit.map((r) => (
                  <tr
                    key={r.repo}
                    className="border-b-hairline last:border-b-0 transition-colors hover:bg-muted/40"
                  >
                    <td className="py-2 pr-3 font-mono text-token-xs text-foreground/90">
                      {r.repo}
                    </td>
                    <td className="py-2 pr-3">
                      <StatusPill status={LANE_TONE[r.lane]}>{r.lane}</StatusPill>
                    </td>
                    <td className="py-2 text-token-xs text-muted-foreground">{r.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </StateBoundary>
  );
}
