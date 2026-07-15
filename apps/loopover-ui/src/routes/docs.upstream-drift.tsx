import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/upstream-drift.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock primitives --
// not fumadocs-ui's bundled components. See docs-source.ts's comment for why the
// loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/upstream-drift")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["upstream-drift"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "Upstream drift — LoopOver docs" },
      {
        name: "description",
        content:
          "LoopOver tracks versioned upstream Gittensor source/ruleset snapshots, hashes semantic payloads, and warns when assumptions drift.",
      },
      { property: "og:title", content: "Upstream drift — LoopOver docs" },
      {
        property: "og:description",
        content:
          "LoopOver tracks versioned upstream Gittensor source/ruleset snapshots, hashes semantic payloads, and warns when assumptions drift.",
      },
      { property: "og:url", content: "/docs/upstream-drift" },
    ],
    links: [{ rel: "canonical", href: "/docs/upstream-drift" }],
  }),
  component: UpstreamDrift,
});

function UpstreamDrift() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Core concepts" title={title} description={description}>
      <Suspense fallback={<p className="text-token-sm text-muted-foreground">Loading…</p>}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
