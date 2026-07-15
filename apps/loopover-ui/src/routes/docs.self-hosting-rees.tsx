import { createFileRoute, notFound } from "@tanstack/react-router";
import { Suspense } from "react";

import { DocsPage } from "@/components/site/docs-page";
import { docsClientLoader } from "@/lib/docs-client-loader";

// Rendered from content/docs/self-hosting-rees.mdx via fumadocs-mdx's browser entry
// (docsClientLoader), through the existing DocsPage/Callout/CodeBlock/FeatureRow
// primitives -- not fumadocs-ui's bundled components. See docs-source.ts's comment
// for why the loader below resolves only a plain, serializable path string.
export const Route = createFileRoute("/docs/self-hosting-rees")({
  loader: async () => {
    const { docsSource } = await import("@/lib/docs-source");
    const page = docsSource.getPage(["self-hosting-rees"]);
    if (!page) throw notFound();
    return { path: page.path, title: page.data.title, description: page.data.description };
  },
  head: () => ({
    meta: [
      { title: "REES enrichment — LoopOver docs" },
      {
        name: "description",
        content:
          "Configure REES for self-hosted LoopOver reviews, including service auth, analyzer selection, result visibility, and troubleshooting.",
      },
      { property: "og:title", content: "REES enrichment — LoopOver docs" },
      {
        property: "og:description",
        content:
          "Configure REES for self-hosted LoopOver reviews, including service auth, analyzer selection, result visibility, and troubleshooting.",
      },
      { property: "og:url", content: "/docs/self-hosting-rees" },
    ],
    links: [{ rel: "canonical", href: "/docs/self-hosting-rees" }],
  }),
  component: SelfHostingRees,
});

function SelfHostingRees() {
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
