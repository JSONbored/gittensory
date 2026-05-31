import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Eye, EyeOff } from "lucide-react";

import {
  BoundaryBadge,
  DiffBlock,
  MiniSparkbar,
  StatusPill,
  type Status,
} from "@/components/site/control-primitives";
import { StatCard } from "@/components/site/primitives";
import { StateBoundary, usePreviewDataState } from "@/components/site/state-views";
import { useApiResource } from "@/lib/api/use-api-resource";
import { mockInstallations, mockNoiseMetrics, mockReviewability } from "@/lib/api/mock";
import { cn } from "@/lib/utils";

const BUCKET_TONE: Record<string, Status> = {
  "review-now": "ready",
  "needs-author": "warn",
  watch: "info",
  redirect: "blocked",
};

type InstallationHealth = {
  installationId: number;
  accountLogin: string;
  installedReposCount: number;
  status: "healthy" | "needs_attention" | "broken";
  missingPermissions: string[];
  missingEvents: string[];
  checkedAt: string;
};

type InstallationsResponse = {
  installations: unknown[];
  health: InstallationHealth[];
};

export function MaintainerPanel() {
  const state = usePreviewDataState("Maintainer repo intelligence");
  const live = useApiResource<InstallationsResponse>("/v1/installations", "Install health");
  const installations =
    live.status === "ready"
      ? live.data.health.map((i) => ({
          id: String(i.installationId),
          account: i.accountLogin,
          repos: i.installedReposCount,
          status:
            i.status === "healthy"
              ? ("ready" as const)
              : i.status === "broken"
                ? ("broken" as const)
                : ("degraded" as const),
          permissions_ok: i.missingPermissions.length === 0,
          webhook_ok: i.missingEvents.length === 0,
          last_event: i.checkedAt,
        }))
      : mockInstallations;
  const isEmpty = installations.length === 0 && mockReviewability.length === 0;
  const refresh = () => {
    state.refresh();
    void live.reload();
  };

  return (
    <StateBoundary
      isLoading={state.isLoading}
      isEmpty={isEmpty}
      onRetry={state.retry}
      onRefresh={refresh}
      loadingTitle="Loading maintainer context…"
      emptyTitle="No maintainer data yet"
      emptyDescription="Install health, reviewability, and surface previews appear after repository data is available."
    >
      <div className="space-y-6">
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {mockNoiseMetrics.map((m) => (
            <StatCard
              key={m.label}
              label={m.label}
              value={m.value.toLocaleString()}
              hint={<MiniSparkbar values={m.spark} />}
            />
          ))}
        </section>

        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-token border-hairline bg-card p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-display text-token-lg font-semibold">Install health</h2>
              <StatusPill
                status={
                  live.status === "ready" ? "ready" : live.status === "error" ? "warn" : "info"
                }
              >
                {live.status === "ready"
                  ? "live"
                  : live.status === "error"
                    ? "mock fallback"
                    : "checking"}
              </StatusPill>
            </div>
            {live.status === "error" && (
              <p className="mt-2 text-token-2xs text-muted-foreground">
                Live install health failed ({live.error}); showing preview data.
              </p>
            )}
            <ul className="mt-4 space-y-3">
              {installations.map((i) => (
                <li
                  key={i.id}
                  className="rounded-token border-hairline bg-background/40 p-3 transition-colors hover:border-strong"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="font-medium">{i.account}</div>
                      <div className="font-mono text-token-2xs text-muted-foreground">
                        {i.id} · {i.repos} repos
                      </div>
                    </div>
                    <StatusPill
                      status={
                        i.status === "ready"
                          ? "ready"
                          : i.status === "degraded"
                            ? "warn"
                            : "blocked"
                      }
                    >
                      {i.status}
                    </StatusPill>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-token-2xs">
                    <StatusPill status={i.permissions_ok ? "ready" : "blocked"}>
                      perms {i.permissions_ok ? "ok" : "missing"}
                    </StatusPill>
                    <StatusPill status={i.webhook_ok ? "ready" : "warn"}>
                      webhook {i.webhook_ok ? "ok" : "lagging"}
                    </StatusPill>
                    <span className="font-mono text-muted-foreground">
                      last event {new Date(i.last_event).toUTCString().slice(5, 22)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-token border-hairline bg-card p-5">
            <h2 className="font-display text-token-lg font-semibold">Repo settings preview</h2>
            <p className="mt-1 text-token-xs text-muted-foreground">
              Suggested changes to <code className="font-mono">.gittensor.yml</code>. Preview-only —
              no writes.
            </p>
            <div className="mt-3">
              <DiffBlock
                removed={["public_surface: comments", "check_mode: always", "label_policy: legacy"]}
                added={[
                  "public_surface: confirmed-miner-only",
                  "check_mode: opt-in",
                  "label_policy: { fixes: required, area: optional }",
                  "maintainer_lane: { paths: [docs/**] }",
                ]}
              />
            </div>
          </div>
        </section>

        <section className="rounded-token border-hairline bg-card p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-token-lg font-semibold">Reviewability queue</h2>
            <span className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
              private
            </span>
          </div>
          <table className="mt-4 w-full text-left text-token-sm">
            <thead>
              <tr className="border-b-hairline font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                <th className="py-2 pr-3 font-normal">PR</th>
                <th className="py-2 pr-3 font-normal">Title</th>
                <th className="py-2 pr-3 font-normal">Author</th>
                <th className="py-2 pr-3 font-normal">Bucket</th>
                <th className="py-2 font-normal">Reason</th>
              </tr>
            </thead>
            <tbody>
              {mockReviewability.map((r) => (
                <tr
                  key={r.pr}
                  className="border-b-hairline last:border-b-0 transition-colors hover:bg-muted/40"
                >
                  <td className="py-2 pr-3 font-mono text-token-xs text-foreground/90">{r.pr}</td>
                  <td className="py-2 pr-3">{r.title}</td>
                  <td className="py-2 pr-3 text-token-xs text-muted-foreground">{r.author}</td>
                  <td className="py-2 pr-3">
                    <StatusPill status={BUCKET_TONE[r.bucket]}>{r.bucket}</StatusPill>
                  </td>
                  <td className="py-2 text-token-xs text-muted-foreground">{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <SurfacePreview />
      </div>
    </StateBoundary>
  );
}

type Side = "public" | "private";

function SurfacePreview() {
  const [side, setSide] = useState<Side>("public");
  return (
    <section className="rounded-token border-hairline bg-card p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-token-lg font-semibold">Surface preview</h2>
          <p className="mt-1 text-token-xs text-muted-foreground">
            Flip between what shows on GitHub publicly and what only you see in private MCP / API
            context.
          </p>
        </div>
        <div className="inline-flex rounded-token border-hairline bg-background/40 p-0.5">
          {[
            {
              id: "public" as const,
              label: "Public on GitHub",
              icon: <Eye className="size-3.5" />,
            },
            {
              id: "private" as const,
              label: "Private to you",
              icon: <EyeOff className="size-3.5" />,
            },
          ].map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSide(s.id)}
              className={cn(
                "inline-flex min-w-0 items-center justify-center gap-1.5 rounded-token px-3 py-1 text-token-xs font-medium leading-token-snug transition-all duration-150 focus-ring motion-reduce:transition-none motion-reduce:active:scale-100 active:scale-[0.98]",
                side === s.id
                  ? "bg-mint/15 text-mint"
                  : "text-muted-foreground hover:text-foreground",
              )}
              aria-pressed={side === s.id}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={side}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2 }}
          className="mt-5"
        >
          {side === "public" ? <PublicSide /> : <PrivateSide />}
        </motion.div>
      </AnimatePresence>
    </section>
  );
}

function PublicSide() {
  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <div className="overflow-hidden rounded-token border-hairline bg-background/40">
        <div className="flex items-center justify-between border-b-hairline px-3 py-2 text-token-2xs text-muted-foreground">
          <span className="font-mono">github.com · PR #1218 · sticky comment</span>
          <StatusPill status="ready">posted</StatusPill>
        </div>
        <div className="space-y-2 p-4 text-token-sm text-foreground/90">
          <div className="flex items-center gap-2">
            <span className="inline-flex size-5 items-center justify-center rounded-token bg-mint text-token-2xs font-bold text-primary-foreground">
              G
            </span>
            <span className="font-mono text-token-xs">gittensory[bot]</span>
            <span className="ml-auto rounded-token border-hairline px-1.5 py-0.5 font-mono text-token-2xs uppercase tracking-wider text-mint">
              confirmed-miner
            </span>
          </div>
          <p>
            Thanks for the PR. This branch links to issue <code className="font-mono">#1204</code>{" "}
            and passes basic preflight. Maintainers can run{" "}
            <code className="font-mono">@gittensory blockers</code> for non-public context.
          </p>
          <div className="flex flex-wrap gap-1.5 pt-2 text-token-2xs">
            <span className="rounded-token border-hairline px-1.5 py-0.5 font-mono text-muted-foreground">
              label · confirmed-miner
            </span>
            <span className="rounded-token border-hairline px-1.5 py-0.5 font-mono text-muted-foreground">
              label · area:queue
            </span>
          </div>
        </div>
      </div>
      <div className="space-y-3">
        <div className="rounded-token border-hairline bg-success/5 p-3">
          <div className="font-mono text-token-2xs uppercase tracking-wider text-success">
            Always posted
          </div>
          <ul className="mt-2 space-y-1 text-token-sm text-foreground/90">
            <li>One sticky maintainer-friendly summary</li>
            <li>Configured confirmed-miner label</li>
            <li>Linked-issue confirmation only</li>
          </ul>
        </div>
        <div className="rounded-token border-hairline bg-danger/5 p-3">
          <div className="font-mono text-token-2xs uppercase tracking-wider text-danger">
            Never posted
          </div>
          <ul className="mt-2 space-y-1 text-token-sm text-foreground/90">
            <li>Scoreability, risk, or reward numbers</li>
            <li>Private reviewability bucket</li>
            <li>Duplicate / cleanup reasoning</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function PrivateSide() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-token border-hairline bg-mint/[0.04] px-3 py-2 text-token-xs text-foreground/85">
        <span>This view is delivered via private MCP / API. It is never posted to GitHub.</span>
        <BoundaryBadge boundary="private-api" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-token border-hairline bg-background/40 p-4">
          <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Miner context
          </div>
          <ul className="mt-2 space-y-1.5 text-token-sm text-foreground/90">
            <li>
              <strong>octocat</strong> — confirmed Gittensor miner
            </li>
            <li>Active in 3 registered repos</li>
            <li>
              Lane fit: <code className="font-mono">pursue</code>
            </li>
          </ul>
        </div>
        <div className="rounded-token border-hairline bg-background/40 p-4">
          <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
            Reviewability packet
          </div>
          <ul className="mt-2 space-y-1.5 text-token-sm text-foreground/90">
            <li>
              Bucket: <code className="font-mono">review-now</code>
            </li>
            <li>Diff size: small · 3 files</li>
            <li>Duplicate risk: low</li>
            <li>Validation summary: present</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
