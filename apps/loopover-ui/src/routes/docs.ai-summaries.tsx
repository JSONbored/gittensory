import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/ai-summaries.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/ai-summaries")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["ai-summaries"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "AI summaries — LoopOver docs" },
      {
        name: "description",
        content:
          "How LoopOver uses AI: only over deterministic signals, never as a source of truth, with strict public/private boundaries.",
      },
      { property: "og:title", content: "AI summaries — LoopOver docs" },
      {
        property: "og:description",
        content:
          "How LoopOver uses AI: only over deterministic signals, never as a source of truth, with strict public/private boundaries.",
      },
      { property: "og:url", content: "/docs/ai-summaries" },
    ],
    links: [{ rel: "canonical", href: "/docs/ai-summaries" }],
  }),
  component: AiSummariesDoc,
});

function AiSummariesDoc() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Roadmap · exploring" title={title} description={description}>
      <Suspense fallback={<p className="text-token-sm text-muted-foreground">Loading…</p>}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
