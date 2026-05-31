import { useState } from "react";
import {
  Bell,
  CheckCircle2,
  AlertTriangle,
  Inbox,
  Activity,
  GitPullRequestArrow,
} from "lucide-react";

import { StatusPill } from "@/components/site/control-primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { StateBoundary, usePreviewDataState } from "@/components/site/state-views";
import { mockDigest, type DigestItem } from "@/lib/api/mock";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const ICONS: Record<DigestItem["kind"], React.ReactNode> = {
  summary: <Activity className="size-4 text-mint" />,
  "review-now": <GitPullRequestArrow className="size-4 text-success" />,
  queue: <Inbox className="size-4 text-warning" />,
  drift: <AlertTriangle className="size-4 text-warning" />,
  install: <Bell className="size-4 text-foreground/70" />,
};

export function DigestPanel() {
  const [subscribed, setSubscribed] = useState(false);
  const state = usePreviewDataState("Maintainer digest");

  return (
    <StateBoundary
      isLoading={state.isLoading}
      isEmpty={mockDigest.items.length === 0}
      onRetry={state.retry}
      onRefresh={state.refresh}
      loadingTitle="Loading digest…"
      emptyTitle="No digest updates yet"
      emptyDescription="When there are reviewability, install, or drift updates, the digest preview will show them here."
    >
      <div className="grid gap-8 lg:grid-cols-[340px_1fr] lg:items-start">
        <div className="mx-auto w-full max-w-[320px]">
          <PhoneFrame>
            <DigestStream items={mockDigest.items.slice(0, 4)} compact date={mockDigest.date} />
          </PhoneFrame>
          <p className="mt-3 text-center text-token-2xs text-muted-foreground">
            Preview of the PWA home tile.
          </p>
        </div>

        <div className="rounded-token border-hairline bg-card p-6">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
                Today · {mockDigest.date}
              </div>
              <h2 className="mt-1 font-display text-token-xl font-semibold">
                {mockDigest.items.length} updates worth looking at
              </h2>
            </div>
            <StatusPill status={mockDigest.signal === "ready" ? "ready" : "warn"}>
              Signal · {mockDigest.signal}
            </StatusPill>
          </div>
          <ul className="mt-5 divide-hairline">
            {mockDigest.items.map((it, i) => (
              <li
                key={i}
                className="flex gap-3 py-3.5 transition-colors hover:bg-muted/30 rounded-token px-2 -mx-2"
              >
                <span className="mt-0.5 shrink-0">{ICONS[it.kind]}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-token-sm font-medium text-foreground">{it.title}</h3>
                    {it.meta && (
                      <span className="font-mono text-token-2xs text-muted-foreground">
                        {it.meta}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-token-sm text-muted-foreground">{it.detail}</p>
                </div>
              </li>
            ))}
          </ul>

          <SubscribeForm subscribed={subscribed} onSubscribe={() => setSubscribed(true)} />
        </div>
      </div>
    </StateBoundary>
  );
}

function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-[2.2rem] border-hairline bg-background p-2 shadow-2xl">
      <div className="overflow-hidden rounded-[1.7rem] border-hairline bg-card">
        <div className="flex items-center justify-between bg-background/60 px-5 py-1.5 text-token-2xs font-mono text-muted-foreground">
          <span>9:41</span>
          <span className="size-1.5 rounded-full bg-mint" />
        </div>
        <div className="max-h-[540px] overflow-auto p-4">{children}</div>
      </div>
    </div>
  );
}

function DigestStream({
  items,
  compact,
  date,
}: {
  items: DigestItem[];
  compact?: boolean;
  date: string;
}) {
  return (
    <div>
      <div className="mb-3">
        <div className="font-display text-token-base font-semibold">Gittensory</div>
        <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
          digest · {date}
        </div>
      </div>
      <ul className="space-y-2">
        {items.map((it, i) => (
          <li
            key={i}
            className={cn(
              "rounded-token border-hairline bg-background/40 p-2.5",
              compact && "text-token-xs",
            )}
          >
            <div className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0">{ICONS[it.kind]}</span>
              <div className="min-w-0">
                <div className="truncate text-foreground">{it.title}</div>
                <div className="line-clamp-2 text-token-2xs text-muted-foreground">{it.detail}</div>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SubscribeForm({
  subscribed,
  onSubscribe,
}: {
  subscribed: boolean;
  onSubscribe: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubscribe();
        toast.success("Digest preview saved", {
          description: "You’ll be notified here when the real digest subscription ships.",
        });
      }}
      className="mt-6 flex flex-col gap-3 rounded-token border-hairline bg-background/40 p-4 sm:flex-row sm:items-center"
    >
      <div className="flex-1">
        <div className="font-mono text-token-2xs uppercase tracking-wider text-muted-foreground">
          Email digest (preview)
        </div>
        <div className="mt-0.5 text-token-sm">Get this delivered each morning once we ship.</div>
      </div>
      <Input
        type="email"
        required
        placeholder="you@maintainer.dev"
        disabled={subscribed}
        className="flex-1"
      />
      {subscribed ? (
        <Button type="button" variant="outline" disabled className="border-success/40 text-success">
          <CheckCircle2 className="size-3.5" />
          On the list
        </Button>
      ) : (
        <Button type="submit">Notify me</Button>
      )}
    </form>
  );
}
