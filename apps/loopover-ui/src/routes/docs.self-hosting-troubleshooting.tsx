import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/self-hosting-troubleshooting.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/self-hosting-troubleshooting")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["self-hosting-troubleshooting"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "Self-host troubleshooting — LoopOver docs" },
      {
        name: "description",
        content:
          "Troubleshoot self-hosted LoopOver reviews: webhook delivery, AI unavailable, REES silent, RAG empty, queue stuck, GitHub rate limits, Qdrant, Orb, AI provider circuit breakers, and readiness failures.",
      },
      { property: "og:title", content: "Self-host troubleshooting — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Troubleshoot self-hosted LoopOver reviews: webhook delivery, AI unavailable, REES silent, RAG empty, queue stuck, GitHub rate limits, Qdrant, Orb, AI provider circuit breakers, and readiness failures.",
      },
      { property: "og:url", content: "/docs/self-hosting-troubleshooting" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-troubleshooting" }],
  }),
  component: SelfHostingTroubleshooting,
});

function SelfHostingTroubleshooting() {
  const { path, title, description } = Route.useLoaderData();
  const Content = docsClientLoader.getComponent(path);
  return (
    <DocsPage eyebrow="Self-hosting" title={title} description={description}>
      <Suspense fallback={<p className="text-token-sm text-muted-foreground">Loading…</p>}>
        <Content />
      </Suspense>
    </DocsPage>
  );
}
