import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { GitPullRequestArrow, MessageSquare } from "lucide-react";

import { StatusPill } from "@/components/site/control-primitives";
import { StateBoundary, usePreviewDataState } from "@/components/site/state-views";
import { mockCommands, type CommandSample } from "@/lib/api/mock";
import { cn } from "@/lib/utils";

export function CommandsPanel() {
  const [selected, setSelected] = useState<CommandSample>(mockCommands[1]);
  const state = usePreviewDataState("GitHub command samples");

  return (
    <StateBoundary
      isLoading={state.isLoading}
      isEmpty={mockCommands.length === 0}
      onRetry={state.retry}
      onRefresh={state.refresh}
      loadingTitle="Loading command samples…"
      emptyTitle="No command samples yet"
      emptyDescription="Maintainer command previews will appear after command metadata is available."
    >
      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <ul className="space-y-2">
          {mockCommands.map((c) => {
            const active = c.id === selected.id;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => setSelected(c)}
                  className={cn(
                    "w-full rounded-token border-hairline p-3 text-left transition-all duration-150 focus-ring motion-reduce:transition-none motion-reduce:active:scale-100 active:scale-[0.99]",
                    active
                      ? "border-strong bg-mint/[0.04]"
                      : "hover:border-strong hover:bg-muted/40",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-token-xs text-foreground">{c.command}</span>
                    <StatusPill status={c.boundary === "public" ? "ready" : "info"}>
                      {c.audience}
                    </StatusPill>
                  </div>
                  <p className="mt-1 text-token-xs text-muted-foreground">{c.description}</p>
                </button>
              </li>
            );
          })}
        </ul>

        <PrThread sample={selected} />
      </div>
    </StateBoundary>
  );
}

function PrThread({ sample }: { sample: CommandSample }) {
  return (
    <div className="overflow-hidden rounded-token border-hairline bg-card">
      <div className="flex items-center gap-2 border-b-hairline bg-background/40 px-4 py-2.5">
        <GitPullRequestArrow className="size-4 text-mint" />
        <div className="font-mono text-token-xs text-foreground/90">
          jsonbored/gittensory <span className="text-muted-foreground">·</span> PR #1218
        </div>
        <span className="ml-auto rounded-full border-hairline bg-mint/10 px-2 py-0.5 font-mono text-token-2xs uppercase tracking-wider text-mint">
          confirmed-miner
        </span>
      </div>

      <div className="space-y-4 p-4">
        <Comment author="maintainer" body={sample.usage} muted />
        <AnimatePresence mode="wait">
          <motion.div
            key={sample.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.25 }}
          >
            <BotReply boundary={sample.boundary} body={sample.reply} />
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function Comment({ author, body, muted }: { author: string; body: string; muted?: boolean }) {
  return (
    <div className="rounded-token border-hairline bg-background/40 p-3">
      <div className="mb-1 flex items-center gap-2 text-token-xs">
        <MessageSquare className="size-3 text-muted-foreground" />
        <span className={cn("font-mono", muted ? "text-muted-foreground" : "text-foreground")}>
          {author}
        </span>
      </div>
      <pre className="whitespace-pre-wrap font-mono text-token-xs text-foreground/90">{body}</pre>
    </div>
  );
}

function BotReply({ boundary, body }: { boundary: CommandSample["boundary"]; body: string }) {
  const isPrivate = boundary !== "public";
  return (
    <div
      className={cn(
        "rounded-token border-hairline p-3",
        isPrivate ? "bg-mint/[0.04]" : "bg-success/[0.04]",
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <span
          className={cn(
            "inline-flex size-5 items-center justify-center rounded-token text-token-2xs font-bold",
            isPrivate ? "bg-mint text-primary-foreground" : "bg-success text-background",
          )}
        >
          G
        </span>
        <span className="font-mono text-token-xs text-foreground">gittensory[bot]</span>
        {isPrivate ? (
          <span className="ml-auto rounded-token border-hairline px-1.5 py-0.5 font-mono text-token-2xs uppercase tracking-wider text-mint">
            delivered privately
          </span>
        ) : (
          <span className="ml-auto rounded-token border-hairline px-1.5 py-0.5 font-mono text-token-2xs uppercase tracking-wider text-success">
            posted to PR
          </span>
        )}
      </div>
      <div className="markdown-mini text-token-sm text-foreground/90">
        {body.split("\n").map((line, i) => (
          <p key={i} className={cn("min-h-[1em]", line.startsWith("- ") && "ml-2")}>
            {renderInline(line)}
          </p>
        ))}
      </div>
    </div>
  );
}

function renderInline(line: string) {
  const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g).filter(Boolean);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("`") && p.endsWith("`"))
      return (
        <code
          key={i}
          className="rounded-token bg-background/60 px-1 font-mono text-token-xs text-mint"
        >
          {p.slice(1, -1)}
        </code>
      );
    if (p.startsWith("_") && p.endsWith("_"))
      return (
        <em key={i} className="text-muted-foreground">
          {p.slice(1, -1)}
        </em>
      );
    return <span key={i}>{p}</span>;
  });
}
