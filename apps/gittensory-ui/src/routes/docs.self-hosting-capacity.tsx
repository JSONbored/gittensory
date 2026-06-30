import { createFileRoute, Link } from "@tanstack/react-router";

import { DocsPage } from "@/components/site/docs-page";
import { Callout, CodeBlock } from "@/components/site/primitives";

export const Route = createFileRoute("/docs/self-hosting-capacity")({
  head: () => ({
    meta: [
      { title: "Self-host capacity and resources — Gittensory docs" },
      {
        name: "description",
        content:
          "Choose the right Gittensory self-host profile with realistic startup, memory, disk, image-size, and operational tradeoff guidance.",
      },
      { property: "og:title", content: "Self-host capacity and resources — Gittensory docs" },
      {
        property: "og:description",
        content:
          "Choose the right Gittensory self-host profile with realistic startup, memory, disk, image-size, and operational tradeoff guidance.",
      },
      { property: "og:url", content: "/docs/self-hosting-capacity" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-capacity" }],
  }),
  component: SelfHostingCapacity,
});

function SelfHostingCapacity() {
  return (
    <DocsPage
      eyebrow="Self-hosting"
      title="Capacity and resources"
      description="Pick profiles with realistic costs. The default stack stays small; observability, RAG backends, local models, and runners are explicit tradeoffs."
    >
      <Callout variant="note" title="Representative, not contractual">
        These envelopes were captured from the current compose stack on June 30, 2026 with{" "}
        <code>docker stats --no-stream</code> after first healthy boot. Use them as planning
        anchors, then re-measure on your own hardware before a production rollout.
      </Callout>

      <h2>What the measurements mean</h2>
      <p>
        Idle CPU stayed close to zero across every profile. The real spikes come from live review
        traffic, model inference, log volume, and CI jobs, so startup time, steady RAM, and disk
        growth are the planning numbers that matter most.
      </p>

      <h2>Profile matrix</h2>
      <div className="not-prose overflow-x-auto rounded-token border border-border">
        <table className="w-full min-w-[860px] text-left text-token-sm">
          <thead className="border-b border-border text-token-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Mode</th>
              <th className="px-4 py-3">What starts</th>
              <th className="px-4 py-3">Ready time</th>
              <th className="px-4 py-3">Steady RAM</th>
              <th className="px-4 py-3">Pull / image cost</th>
              <th className="px-4 py-3">Operational note</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border/70 align-top">
              <td className="px-4 py-3 font-medium text-foreground">Minimal (default)</td>
              <td className="px-4 py-3">
                <code>gittensory</code> + <code>redis</code>
              </td>
              <td className="px-4 py-3">about 15s</td>
              <td className="px-4 py-3">about 150 MiB</td>
              <td className="px-4 py-3">about 0.47 GB total images</td>
              <td className="px-4 py-3">
                Best first deploy. The SQLite volume started under 10 MiB after boot.
              </td>
            </tr>
            <tr className="border-b border-border/70 align-top">
              <td className="px-4 py-3 font-medium text-foreground">Backup</td>
              <td className="px-4 py-3">
                Minimal + <code>backup</code>
              </td>
              <td className="px-4 py-3">about 15s</td>
              <td className="px-4 py-3">about 160 MiB</td>
              <td className="px-4 py-3">about 4 MiB extra image</td>
              <td className="px-4 py-3">
                Cheap to keep enabled. The backup volume grows with retention, not with the idle
                service.
              </td>
            </tr>
            <tr className="border-b border-border/70 align-top">
              <td className="px-4 py-3 font-medium text-foreground">Qdrant + Ollama</td>
              <td className="px-4 py-3">
                Minimal + <code>qdrant</code> + <code>ollama</code>
              </td>
              <td className="px-4 py-3">about 15s before model pull</td>
              <td className="px-4 py-3">about 200 MiB before model pull</td>
              <td className="px-4 py-3">about 3.5 GB extra images</td>
              <td className="px-4 py-3">
                Qdrant itself is modest. Ollama is the real weight: model downloads add multi-GB
                disk and inference memory that idle stats do not show.
              </td>
            </tr>
            <tr className="border-b border-border/70 align-top">
              <td className="px-4 py-3 font-medium text-foreground">Observability</td>
              <td className="px-4 py-3">
                Minimal + Prometheus, Alertmanager, Loki, Promtail, Grafana, Tempo, OTEL collector,
                exporter, proxy
              </td>
              <td className="px-4 py-3">app ready about 50s, dashboards about 60-70s</td>
              <td className="px-4 py-3">about 0.7 GiB</td>
              <td className="px-4 py-3">about 0.87 GB extra images</td>
              <td className="px-4 py-3">
                The heaviest always-on profile. Prometheus, Loki, and Grafana volumes grow faster
                than the app DB on a quiet host.
              </td>
            </tr>
            <tr className="align-top">
              <td className="px-4 py-3 font-medium text-foreground">Runners</td>
              <td className="px-4 py-3">
                <code>runner</code> on top of the stack
              </td>
              <td className="px-4 py-3">registration is fast; jobs define the real cost</td>
              <td className="px-4 py-3">do not budget from idle alone</td>
              <td className="px-4 py-3">runner image is about 0.84 GB (amd64)</td>
              <td className="px-4 py-3">
                Treat runners as a separate workload. Reserve at least 20 GB free disk for
                workspace, caches, and downloaded toolchains, and prefer a dedicated host.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Tuned defaults</h2>
      <div className="not-prose overflow-x-auto rounded-token border border-border">
        <table className="w-full min-w-[760px] text-left text-token-sm">
          <thead className="border-b border-border text-token-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Knob</th>
              <th className="px-4 py-3">Default</th>
              <th className="px-4 py-3">Why</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-border/70 align-top">
              <td className="px-4 py-3">
                <code>INSTALL_AI_CLIS</code>
              </td>
              <td className="px-4 py-3">
                Local compose builds default to <code>false</code>
              </td>
              <td className="px-4 py-3">
                The lean local image is about 82 MiB versus about 456 MiB with the Claude Code and
                Codex CLIs baked in. Turn it on only when you need the subscription CLI providers.
              </td>
            </tr>
            <tr className="border-b border-border/70 align-top">
              <td className="px-4 py-3">
                <code>PROMETHEUS_RETENTION_TIME</code>
              </td>
              <td className="px-4 py-3">
                <code>30d</code>
              </td>
              <td className="px-4 py-3">
                The old 180-day default was too expensive for the first-party self-host stack.
                Thirty days keeps recent operator history without pretending observability is free.
              </td>
            </tr>
            <tr className="border-b border-border/70 align-top">
              <td className="px-4 py-3">
                <code>REDIS_MAXMEMORY</code> / <code>REDIS_MAXMEMORY_POLICY</code>
              </td>
              <td className="px-4 py-3">
                <code>256mb</code> / <code>allkeys-lru</code>
              </td>
              <td className="px-4 py-3">
                Redis stays a short-lived cache. It can now be raised or lowered explicitly instead
                of being buried in compose.
              </td>
            </tr>
            <tr className="border-b border-border/70 align-top">
              <td className="px-4 py-3">
                <code>GRAFANA_INSTALL_PLUGINS</code>
              </td>
              <td className="px-4 py-3">SQLite + GitHub plugins</td>
              <td className="px-4 py-3">
                Those power the bundled dashboards, but the list is now operator-controlled when
                startup time or pull size matters more than every dashboard.
              </td>
            </tr>
            <tr className="align-top">
              <td className="px-4 py-3">
                <code>QUEUE_CONCURRENCY</code> / <code>QUEUE_BACKGROUND_CONCURRENCY</code>
              </td>
              <td className="px-4 py-3">
                <code>4</code> / <code>1</code>
              </td>
              <td className="px-4 py-3">
                Keep the main review path parallel enough for I/O-bound work, while background jobs
                cannot consume the whole worker budget.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Resource pressure checks</h2>
      <CodeBlock
        lang="bash"
        code={`docker compose ps
docker stats --no-stream
docker image inspect gittensory-gittensory:latest qdrant/qdrant:v1.18.2 ollama/ollama:0.30.10
docker run --rm -v gittensory_gittensory-data:/data alpine:3.20 du -sh /data
docker system df -v`}
      />
      <p>
        Use <Link to="/docs/self-hosting-operations">Operations</Link> for normal health checks and{" "}
        <Link to="/docs/self-hosting-backup-scaling">Backup and scaling</Link> for restore and
        multi-instance guidance.
      </p>

      <h2>Warning signs</h2>
      <ul>
        <li>
          If Redis approaches <code>REDIS_MAXMEMORY</code> and evictions climb, raise the cap or
          reduce cache-heavy traffic before webhook dedup and short-lived caches churn.
        </li>
        <li>
          If <code>prometheus-data</code>, <code>loki-data</code>, or <code>grafana-data</code> grow
          faster than the app DB, shorten retention or move observability to a larger host.
        </li>
        <li>
          If Ollama is enabled, treat every pulled model as a separate disk and RAM commitment. The
          base container staying light does not mean inference will.
        </li>
        <li>
          If you enable runners, isolate them from the control-plane host whenever possible.
          Workflow jobs can consume more disk, network, and CPU than the review service itself.
        </li>
      </ul>

      <h2>Local build recommendations</h2>
      <CodeBlock
        lang="bash"
        code={`# default local compose build: lean, no subscription CLIs
docker compose up -d --build

# opt in only when you need claude-code or codex inside the app container
INSTALL_AI_CLIS=true docker compose build gittensory
docker compose up -d gittensory`}
      />
      <p>
        Published GHCR release images still include the subscription CLIs for convenience. The
        leaner compose default is for local and private operator builds where that convenience is
        not always worth a 5x image-size jump.
      </p>
    </DocsPage>
  );
}
